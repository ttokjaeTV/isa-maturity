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
 *  - openMonth: ISA를 여는 달(1~12). 그 달에 그 해 한도, 다음 1월부터 매년 새 한도. 1월이면 매년 1월 1회(엑셀 방식),
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
      initialRoom: 0, // >0이면 첫 ISA에 이월 한도가 쌓여 있어 처음에 이만큼 넣을 수 있음(최대 1억)
      firstAge: 0,    // (옛 방식) 기존 ISA 가입 후 지난 개월 수 (0~35)
      firstMat: 0,    // 첫 ISA 해지·연금 전환까지 남은 개월 수 (0이면 36 − firstAge)
    }, p || {});
    if (!(P.openMonth >= 1 && P.openMonth <= 12)) P.openMonth = P.schedule === 'fast' ? 12 : 1;
    P.openMonth = Math.round(P.openMonth);
    if (P.mode === 'annual') P.openMonth = 1;
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
    const firstRoom = P.initialRoom > 0 ? Math.min(Math.max(P.initialRoom, ISA_YEAR_LIMIT), ISA_TOTAL_LIMIT) : ISA_YEAR_LIMIT;
    const m1 = P.firstMat;
    const isMat = m => m > 0 && m >= m1 && (m - m1) % 36 === 0;
    const A = { isa: 0, isaPrin: 0, room: firstRoom, openM: P.firstMat === 36 ? 0 : -1, pen: 0, penFree: 0,
      refundPot: 0, refundPotPrin: 0, refundCash: 0, gen: { v: 0, c: 0 }, paid: 0, transfers: [] };
    const B = { isa: 0, isaPrin: 0, room: firstRoom, gen: { v: 0, c: 0 }, paid: 0 };
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
      // (2) 연말 스냅샷
      if (m > 0 && m % 12 === 0 && !probe) {
        years.push({
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

  const api = { simulate, ISA_YEAR_LIMIT, ISA_TOTAL_LIMIT, TRANSFER_CREDIT_CAP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IsaEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
