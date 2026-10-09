/* ISA 만기 전략 계산 엔진 (브라우저·Node 공용)
 * 전략A: ISA 3년 만기마다 해지 → 세후금액을 연금저축으로 이전(전환금액 10%, 최대 300만원 추가 세액공제) → 즉시 새 ISA
 * 전략B: ISA 하나를 해지 없이 유지(총 납입 1억 한도), 운용 종료 시점에 해지
 *
 * 돈의 흐름 (세 가지 방식 모두 같은 규칙)
 *  - 들어오는 돈(목돈·매년 저축)은 먼저 일반계좌에 들어간다.
 *  - 매달, ISA 남은 한도 안에서 일반계좌 돈을 ISA로 옮긴다(이익분은 15.4% 과세 후 이동).
 *  - ISA 한도: 계좌를 연 달에 그 해 2,000만원이 생기고, 이후 매년 1월에 2,000만원씩 더 생긴다(미사용분 이월).
 *    계좌당 총 납입 1억원. 해지 후 새로 연 계좌는 한도가 처음부터 다시 생긴다.
 *  - initialRoom: 이미 가입해 둔 ISA에 이월 한도가 쌓인 특수한 경우, 첫 계좌(A의 첫 사이클·B)에 처음부터 그만큼 한도가 있다고 본다.
 *  - firstMat: 그 기존 ISA를 첫 해지(만기)·연금 전환하는 시점, 지금부터 몇 개월 뒤(1~). 이후 새 ISA는 3년마다.
 *    (가입 3년 미만이면 36 − 지난 개월, 3년 지난 계좌는 언제든 해지 가능하므로 사용자가 고른 값. 옛 firstAge도 받음)
 *  - openMonth: ISA를 여는 달(1~12). 그 달에 그 해 한도, 다음 1월부터 매년 새 한도. 매년 저축 방식은 매년 이 달에 넣는다. 1월이면 매년 1월 1회(엑셀 방식),
 *    12월이면 한 달 뒤 1월에 바로 다음 해 한도가 생겨 가장 빨리 넣을 수 있다. (옛 schedule 'yearly'=1월, 'fast'=12월도 받음)
 * 시간 단위: 월. 수익률은 월 복리((1+r)^(1/12))로 환산해 연 단위 결과가 엑셀과 같게 맞춘다.
 */
(function (root) {
  const ISA_YEAR_LIMIT = 20000000;     // ISA 연간 납입한도 (달력 연도 기준, 미사용분 이월)
  const ISA_TOTAL_LIMIT = 100000000;   // ISA 계좌당 총 납입한도
  const TRANSFER_CREDIT_CAP = 3000000; // 연금 전환 추가 세액공제 대상 상한 (전환금액의 10%, 최대 300만원)
  const MAX_M = 12 * 60;

  // 들어오는 돈: [{m, amt}]
  function buildInflows(p) {
    const f = [];
    if (p.mode === 'none') return f; // 기존 계좌만, 추가 납입 없음
    if (p.mode === 'annual') {
      let left = p.total;
      for (let k = 0; left > 0.5 && k < 60; k++) {
        const amt = Math.min(p.annual, left);
        f.push({ m: 12 * k, amt }); left -= amt;
      }
    } else {
      if (p.lump > 0) f.push({ m: 0, amt: p.lump });
      if (p.mode === 'both') {
        const n = Math.max(0, Math.min(60, Math.round(p.years || 0)));
        for (let k = 0; k < n; k++) if (p.annual > 0) f.push({ m: 12 * k, amt: p.annual });
      }
    }
    return f;
  }

  // 일반계좌: 가치 v, 취득원가 c. 매도 시 이익 비율만큼 과세
  function genBuy(g, amt) { g.v += amt; g.c += amt; }
  function genSell(g, net, tax) {
    if (g.v <= 0) return 0;
    const f = Math.max(g.v - g.c, 0) / g.v;
    const gross = net / (1 - f * tax);
    const s = Math.min(gross, g.v);
    const got = s * (1 - f * tax);
    g.c -= s * (g.c / g.v); g.v -= s;
    if (g.v < 1) { g.v = 0; g.c = 0; }
    return got;
  }
  function genAfterTax(g, tax) { return g.v - Math.max(g.v - g.c, 0) * tax; }

  function simulate(p) {
    const P = Object.assign({
      mode: 'annual', annual: 10000000, total: 100000000, lump: 100000000, years: 10,
      openMonth: 0, schedule: 'yearly', r: 0.08, freeLimit: 2000000, isaTax: 0.099,
      creditRate: 0.132, pensionRate: 0.055, otherRate: 0.165, genTax: 0.154,
      reinvest: true, horizon: 0, excelRefund: false,
      startYear: 2027,
      existing: null,  // 지금 가진 ISA: { value: 평가액, principal: 넣은 원금, room: 지금 넣을 수 있는 한도 } // 시작(개설) 연도 — 표·차트를 달력 연도로 표시할 때 사용
      initialRoom: 0, // >0이면 첫 ISA에 이월 한도가 쌓여 있어 처음에 이만큼 넣을 수 있음(최대 1억)
      firstAge: 0,    // (옛 방식) 기존 ISA 가입 후 지난 개월 수 (0~35)
      firstMat: 0,    // 첫 ISA 해지·연금 전환까지 남은 개월 수 (0이면 36 − firstAge)
    }, p || {});
    if (!(P.openMonth >= 1 && P.openMonth <= 12)) P.openMonth = P.schedule === 'fast' ? 12 : 1;
    P.openMonth = Math.round(P.openMonth);
    const g1 = Math.pow(1 + P.r, 1 / 12);
    const inflows = buildInflows(P);
    P.firstAge = Math.max(0, Math.min(35, Math.round(P.firstAge || 0)));
    P.firstMat = P.firstMat > 0 ? Math.max(1, Math.min(MAX_M - 12, Math.round(P.firstMat))) : 36 - P.firstAge;
    const m1 = P.firstMat; // 전략A 첫 만기 달
    const nextMat = m => m < m1 ? m1 : m1 + 36 * Math.ceil((m - m1 + 1) / 36); // m에 넣은 돈이 들어간 사이클의 만기 달
    const probe = runCore(P, g1, inflows, MAX_M, true);
    const minYears = Math.max(
      probe.lastDepositA >= 0 ? Math.ceil(nextMat(probe.lastDepositA) / 12) : Math.ceil(m1 / 12),
      Math.ceil((probe.lastDepositB + 1) / 12),
      Math.ceil(((inflows.length ? inflows[inflows.length - 1].m : 0) + 1) / 12));
    const H = Math.max(minYears, Math.round(P.horizon || 0), 3); // 비교가 의미 있도록 최소 3년
    const res = runCore(P, g1, inflows, 12 * H, false);
    res.minYears = minYears; res.H = H;
    return res;
  }

  function runCore(P, g1, inflows, endM, probe) {
    const isJan = m => (P.openMonth - 1 + m) % 12 === 0; // m개월 뒤가 1월인지 (m=0은 개설 달)
    const EX = P.existing && (P.existing.value > 0 || P.existing.principal > 0) ? P.existing : null;
    const firstRoom = EX ? Math.max(0, Math.min(EX.room || 0, ISA_TOTAL_LIMIT - (EX.principal || 0)))
      : P.initialRoom > 0 ? Math.min(Math.max(P.initialRoom, ISA_YEAR_LIMIT), ISA_TOTAL_LIMIT) : ISA_YEAR_LIMIT;
    const m1 = P.firstMat;
    const isMat = m => m > 0 && m >= m1 && (m - m1) % 36 === 0;
    const A = { isa: 0, isaPrin: 0, room: firstRoom, openM: P.firstMat === 36 ? 0 : -1, pen: 0, penFree: 0,
      refundPot: 0, refundPotPrin: 0, refundCash: 0, gen: { v: 0, c: 0 }, paid: 0, transfers: [] };
    const B = { isa: 0, isaPrin: 0, room: firstRoom, gen: { v: 0, c: 0 }, paid: 0 };
    if (EX) { A.isa = B.isa = EX.value || 0; A.isaPrin = B.isaPrin = EX.principal || 0; A.openM = -1; } // 같은 기존 계좌에서 출발
    const inMap = new Map();
    inflows.forEach(e => inMap.set(e.m, (inMap.get(e.m) || 0) + e.amt));
    let lastDepositA = -1, lastDepositB = -1, inflowTotal = 0, lumpDoneA = -1;
    const years = [];
    let yr;
    const resetYr = () => { yr = { tr: 0, isaTaxA: 0, creditBase: 0, refund: 0, depA: 0, depB: 0, inflow: 0 }; };
    resetYr();

    for (let m = 0; m <= endM; m++) {
      // (1) 전략A: 만기(36개월마다) 해지 → 연금저축 이전 → 새 ISA 개설
      if (isMat(m)) {
        if (A.isa > 0.5) {
          const gain = A.isa - A.isaPrin;
          const tax = Math.max(gain - P.freeLimit, 0) * P.isaTax;
          const tr = A.isa - tax;
          const base = Math.min(tr * 0.1, TRANSFER_CREDIT_CAP);
          const refund = base * P.creditRate;
          A.pen += tr; A.penFree += tr - base;
          if (P.reinvest) { A.refundPot += refund; A.refundPotPrin += refund; } else A.refundCash += refund;
          A.transfers.push({ m, tr, tax, base, refund });
          yr.tr += tr; yr.isaTaxA += tax; yr.creditBase += base; yr.refund += refund;
        }
        A.isa = 0; A.isaPrin = 0; A.room = ISA_YEAR_LIMIT; A.openM = m;
      }
      // (2) 달력 연말(다음 해 1월 직전) 스냅샷 + 마지막 달
      if (m > 0 && (isJan(m) || m === endM) && !probe) {
        const calIdx = P.openMonth - 1 + m, calYear = P.startYear + Math.floor(calIdx / 12), calMonth = calIdx % 12 + 1;
        const prevM = years.length ? years[years.length - 1].m : 0;
        const jan = isJan(m);
        const label = jan ? (calYear - 1) + '년' : calYear + '년 ' + calMonth + '월';
        years.push({
          m, months: m - prevM, label, calYear: jan ? calYear - 1 : calYear, isFinal: m === endM, partialStart: years.length === 0 && m < 12 ? P.openMonth : 0,
          year: m / 12,
          aIsa: A.isa, aPen: A.pen, aRefund: A.refundPot + A.refundCash, aGen: A.gen.v,
          aTotal: A.isa + A.pen + A.refundPot + A.refundCash + A.gen.v, aPaid: A.paid,
          bIsa: B.isa, bGen: B.gen.v, bTotal: B.isa + B.gen.v, bPaid: B.paid,
          inflowTotal,
          tr: yr.tr, isaTaxA: yr.isaTaxA, creditBase: yr.creditBase, refund: yr.refund,
          depA: yr.depA, depB: yr.depB, inflow: yr.inflow,
        });
        resetYr();
      }
      if (m === endM) break;
      // (3) 새 연도 한도 (1월, 개설 달 제외)
      if (m > 0 && isJan(m)) {
        if (m !== A.openM) A.room += ISA_YEAR_LIMIT;
        B.room += ISA_YEAR_LIMIT;
      }
      // (4) 들어오는 돈 → 일반계좌
      const inc = inMap.get(m);
      if (inc) { genBuy(A.gen, inc); genBuy(B.gen, inc); inflowTotal += inc; yr.inflow += inc; }
      // (5) 한도 안에서 ISA로 이동
      if (A.gen.v > 0.5) {
        const want = Math.min(A.room, ISA_TOTAL_LIMIT - A.isaPrin, genAfterTax(A.gen, P.genTax));
        if (want > 0.5) {
          const amt = genSell(A.gen, want, P.genTax);
          A.isa += amt; A.isaPrin += amt; A.room -= amt; A.paid += amt; yr.depA += amt; lastDepositA = m;
        }
      }
      if (lumpDoneA < 0 && inflowTotal > 0 && A.gen.v <= 0.5) lumpDoneA = m; // 처음으로 대기자금이 0이 된 달 = 목돈을 다 옮긴 시점
      if (B.gen.v > 0.5) {
        const want = Math.min(B.room, ISA_TOTAL_LIMIT - B.isaPrin, genAfterTax(B.gen, P.genTax));
        if (want > 0.5) {
          const amt = genSell(B.gen, want, P.genTax);
          B.isa += amt; B.isaPrin += amt; B.room -= amt; B.paid += amt; yr.depB += amt; lastDepositB = m;
        }
      }
      // (6) 한 달 운용
      A.isa *= g1; A.pen *= g1; if (P.reinvest) A.refundPot *= g1; A.gen.v *= g1;
      B.isa *= g1; B.gen.v *= g1;
    }

    if (probe) return { lastDepositA, lastDepositB, lumpDoneA };

    // 최종 세후 (운용 종료 시점에 모두 찾는다고 가정)
    // 환급 재투자분: 연금저축에 세액공제 안 받은 납입으로 넣은 것으로 보고 원금 비과세·수익만 과세
    // (excelRefund=true면 엑셀처럼 재투자분 전체 비과세)
    const potGain = Math.max(A.refundPot - A.refundPotPrin, 0);
    const penTaxable = Math.max(A.pen - A.penFree, 0);
    const genA = genAfterTax(A.gen, P.genTax);
    const refundPensionTax = P.excelRefund ? 0 : potGain * P.pensionRate;
    const refundOtherTax = P.excelRefund ? 0 : potGain * P.otherRate;
    const aPension = A.penFree + penTaxable * (1 - P.pensionRate) + A.refundPot - refundPensionTax + A.refundCash + genA;
    const aOther = A.penFree + penTaxable * (1 - P.otherRate) + A.refundPot - refundOtherTax + A.refundCash + genA;
    const bIsaTax = Math.max(B.isa - B.isaPrin - P.freeLimit, 0) * P.isaTax;
    const bGenAfter = genAfterTax(B.gen, P.genTax);
    const bFinal = B.isa - bIsaTax + bGenAfter;
    return {
      years, transfers: A.transfers,
      final: {
        aPension, aOther, b: bFinal,
        aPen: A.pen, aPenFree: A.penFree, aPenTaxable: penTaxable,
        aPensionTax: penTaxable * P.pensionRate + refundPensionTax, aOtherTax: penTaxable * P.otherRate + refundOtherTax,
        aRefundValue: A.refundPot + A.refundCash, totalRefund: A.transfers.reduce((s, t) => s + t.refund, 0),
        aIsaTax: A.transfers.reduce((s, t) => s + t.tax, 0), aGen: A.gen.v, aGenAfter: genA,
        bIsa: B.isa, bIsaPrin: B.isaPrin, bIsaTax, bGen: B.gen.v, bGenAfter,
        paid: A.paid, inflowTotal,
      },
      lastDepositA, lastDepositB, lumpDoneA,
    };
  }

  /* 해지 타이밍 비교: 지금 가진 ISA를 '지금(가입 3년 전이면 만기 때) 해지'하는 것과 'N년 더 유지 후 해지'하는 것을 비교
   * p: { value, principal, wait0(해지 가능 시점까지 남은 개월), years(N), r, freeLimit,
   *      dest: 'pension'(연금저축 이전) | 'isa'(새 ISA + 한도 밖은 일반계좌),
   *      genType: 'overseas'(이익 15.4%, 팔 때) | 'domestic'(매매차익 비과세, 분배금만 15.4%), divYield,
   *      creditRate, pensionRate, calMonth(해지 가능 시점의 달 1~12) }
   * 두 경우 모두 N년 뒤 시점에 전부 찾는다(연금 이전이면 그때부터 연금으로 받는다)고 보고 세후 금액을 비교한다. */
  function deferral(p) {
    const P = Object.assign({ value: 0, principal: 0, wait0: 0, years: 3, r: 0.08, freeLimit: 2000000, isaTax: 0.099, genTax: 0.154,
      dest: 'pension', genType: 'overseas', divYield: 0.02, creditRate: 0.132, pensionRate: 0.055, calMonth: 1 }, p || {});
    const g1 = Math.pow(1 + P.r, 1 / 12), M = Math.max(1, Math.round(P.years * 12));
    const gM = Math.pow(g1, M), F = P.freeLimit, T = P.isaTax;
    const isaTaxOf = (v, prin, f) => Math.max(v - prin - f, 0) * T;
    const V0 = P.value * Math.pow(g1, Math.max(0, P.wait0)); // 해지 가능 시점의 평가액 (두 경우 같음)
    // 유지: N년 뒤 해지
    const keepV = V0 * gM, taxLater = isaTaxOf(keepV, P.principal, F), keepCash = keepV - taxLater;
    // 지금 해지
    const taxNow = isaTaxOf(V0, P.principal, F), c = V0 - taxNow;
    // 기준선: 해지한 돈을 같은 세율(9.9%) 계좌에 전부 다시 넣었다고 칠 때 (ideal1 = 비과세 한도 없이, ideal = 새 한도 포함)
    const ideal1 = c * gM - isaTaxOf(c * gM, c, 0), ideal = c * gM - isaTaxOf(c * gM, c, F);
    const out = { V0, taxNow, cashNow: c, keepV, taxLater, keepCash, deferValue: keepCash - ideal1, allowValue: ideal - ideal1, M };
    if (P.dest === 'pension') {
      const pr = P.pensionRate, cr = P.creditRate;
      // 지금 이전: 전환금액 10%(최대 300만원) 세액공제, 환급액은 연금저축에 다시 넣어 굴림(원금 비과세, 수익 과세)
      const base = Math.min(c * 0.1, TRANSFER_CREDIT_CAP), refund = base * cr;
      const penV = c * gM, refV = refund * gM;
      const penTax = (base + (penV - c)) * pr + (refV - refund) * pr;
      out.term = { final: penV + refV - penTax, isaTax: taxNow, isaTax2: 0, genTax: 0, refund, penTax, value: penV + refV };
      // 유지 후 N년 뒤 이전: 그때 받는 환급은 굴릴 시간이 없음
      const base2 = Math.min(keepCash * 0.1, TRANSFER_CREDIT_CAP), refund2 = base2 * cr, penTax2 = base2 * pr;
      out.keep = { final: keepCash + refund2 - penTax2, isaTax: taxLater, refund: refund2, penTax: penTax2, value: keepV };
    } else {
      // 지금 해지 → 바로 새 ISA (그 달 2,000만원, 매년 1월 2,000만원, 계좌당 1억원) + 나머지는 일반계좌에서 대기
      const dom = P.genType === 'domestic', gt = dom ? 0 : P.genTax;
      const gen = { v: c, c: c };
      let isa = 0, prin = 0, room = ISA_YEAR_LIMIT, divTax = 0;
      const isJan = m => (P.calMonth - 1 + m) % 12 === 0;
      for (let m = 0; m < M; m++) {
        if (m > 0 && isJan(m)) room += ISA_YEAR_LIMIT;
        if (gen.v > 0.5) {
          const want = Math.min(room, ISA_TOTAL_LIMIT - prin, genAfterTax(gen, gt));
          if (want > 0.5) { const amt = genSell(gen, want, gt); isa += amt; prin += amt; room -= amt; }
        }
        isa *= g1;
        if (dom) { // 분배금(연 divYield)에 15.4% → 세후 재투자
          const t = gen.v * (P.divYield / 12) * P.genTax; gen.v = gen.v * g1 - t; divTax += t;
        } else gen.v *= g1;
      }
      const isaTax2 = isaTaxOf(isa, prin, F), genTax = Math.max(gen.v - gen.c, 0) * gt + divTax;
      out.term = { final: isa - isaTax2 + gen.v - Math.max(gen.v - gen.c, 0) * gt, isaTax: taxNow, isaTax2, genTax, refund: 0, penTax: 0,
        newIsa: isa, newIsaPrin: prin, gen: gen.v, value: isa + gen.v };
      out.keep = { final: keepCash, isaTax: taxLater, refund: 0, penTax: 0, value: keepV };
    }
    out.diff = out.keep.final - out.term.final; // + 이면 유지가 유리
    return out;
  }

  const api = { simulate, deferral, ISA_YEAR_LIMIT, ISA_TOTAL_LIMIT, TRANSFER_CREDIT_CAP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IsaEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
