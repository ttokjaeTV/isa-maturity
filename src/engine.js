/* ISA 만기 전략 계산 엔진 (브라우저·Node 공용)
 * 전략A: ISA 3년 만기마다 해지 → 세후금액을 연금저축으로 이전(전환금액 10%, 최대 300만원 추가 세액공제) → 즉시 새 ISA
 * 전략B: ISA 하나를 해지 없이 유지(총 납입 1억 한도), 운용 종료 시점에 해지
 * 시간 단위: 월. 수익률은 월 복리((1+r)^(1/12))로 환산해 연 단위 결과가 엑셀과 같게 맞춘다.
 */
(function (root) {
  const ISA_YEAR_LIMIT = 20000000;   // ISA 연간 납입한도 (달력 연도 기준, 미사용분 이월)
  const ISA_TOTAL_LIMIT = 100000000; // ISA 계좌당 총 납입한도
  const TRANSFER_CREDIT_CAP = 3000000; // 연금 전환 추가 세액공제 대상 상한 (전환금액의 10%, 최대 300만원)

  function buildSchedule(p) {
    // 반환: { a: [{m, amt}], b: [{m, amt}] } — 월 단위 납입 시점
    // annual 모드: 현금이 매년 초 들어온다 → 두 전략 모두 들어오는 즉시 납입(B는 1억 초과분 일반계좌)
    // lump 모드: 목돈이 처음부터 있다 → 한도가 허락하는 시점에 납입, 나머지는 일반계좌에서 대기
    const a = [], b = [];
    if (p.mode === 'annual') {
      let left = p.total;
      for (let k = 0; left > 0.5 && k < 60; k++) {
        const amt = Math.min(p.annual, left);
        a.push({ m: 12 * k, amt }); b.push({ m: 12 * k, amt });
        left -= amt;
      }
      return { a, b, cash: 'flow' };
    }
    // lump: 납입 '기회'만 만든다 (실제 금액은 대기자금 잔액으로 결정)
    const horizonM = 12 * 60;
    if (p.schedule === 'fast') {
      // 12월 개설 → 다음 해 1월에 새 연도 한도 → 만기(가입 후 36개월, 12월) 해지 즉시 재가입하면 그 해 한도가 새로 생김
      for (let c = 0; c * 36 < horizonM; c++) {
        const s = c * 36;
        [s, s + 1, s + 13, s + 25].forEach(m => a.push({ m, cap: ISA_YEAR_LIMIT }));
      }
      [0, 1, 13, 25, 37].forEach(m => b.push({ m, cap: ISA_YEAR_LIMIT }));
    } else {
      // 매년 1월 1회 납입 (엑셀 방식)
      for (let k = 0; k < 60; k++) { a.push({ m: 12 * k, cap: ISA_YEAR_LIMIT }); }
      for (let k = 0; k < 5; k++) { b.push({ m: 12 * k, cap: ISA_YEAR_LIMIT }); }
    }
    return { a, b, cash: 'lump' };
  }

  // 일반계좌(대기자금·초과분): 가치 v, 취득원가 c. 매도 시 이익 비율만큼 과세
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
  function genValueAfterTax(g, tax) { return g.v - Math.max(g.v - g.c, 0) * tax; }

  function simulate(p) {
    const P = Object.assign({
      mode: 'annual', annual: 10000000, total: 100000000, lump: 100000000,
      schedule: 'yearly', r: 0.08, freeLimit: 2000000, isaTax: 0.099,
      creditRate: 0.132, pensionRate: 0.055, otherRate: 0.165, genTax: 0.154,
      reinvest: true, horizon: 0, excelRefund: false,
    }, p || {});
    const g1 = Math.pow(1 + P.r, 1 / 12);
    const sch = buildSchedule(P);

    // 최소 운용기간: A의 마지막 납입이 들어간 ISA 사이클이 만기되는 시점(3의 배수 년)
    // lump 모드에서는 먼저 납입 소진 시점을 알아야 하므로 1차로 넉넉히 돌려 계산
    const s = runCore(P, g1, sch, 12 * 60, true);
    const lastA = s.lastDepositA, lastB = s.lastDepositB;
    const minYears = Math.max(Math.ceil((Math.floor(lastA / 36) + 1) * 3), Math.ceil((lastB + 1) / 12));
    const H = Math.max(minYears, Math.round(P.horizon || 0), 1);
    const res = runCore(P, g1, sch, 12 * H, false);
    res.minYears = minYears; res.H = H;
    return res;
  }

  function runCore(P, g1, sch, endM, probe) {
    const A = { isa: 0, isaPrin: 0, pen: 0, penFree: 0, refundPot: 0, refundPotPrin: 0, refundCash: 0,
      gen: { v: 0, c: 0 }, cycleOpen: 0, paid: 0, transfers: [] };
    const B = { isa: 0, isaPrin: 0, gen: { v: 0, c: 0 }, paid: 0 };
    if (sch.cash === 'lump') { A.gen.v = A.gen.c = P.lump; B.gen.v = B.gen.c = P.lump; }
    const da = new Map(), db = new Map();
    sch.a.forEach(e => da.set(e.m, e)); sch.b.forEach(e => db.set(e.m, e));
    let lastDepositA = -1, lastDepositB = -1;
    const years = [];
    let yr = { a: {}, b: {} };
    const resetYr = () => { yr = { tr: 0, isaTaxA: 0, creditBase: 0, refund: 0, depA: 0, depB: 0 }; };
    resetYr();

    for (let m = 0; m <= endM; m++) {
      // (1) 전략A: 만기(36개월마다) 해지 → 연금저축 이전
      if (m > 0 && m % 36 === 0 && A.isa > 0.5) {
        const gain = A.isa - A.isaPrin;
        const tax = Math.max(gain - P.freeLimit, 0) * P.isaTax;
        const tr = A.isa - tax;
        const base = Math.min(tr * 0.1, TRANSFER_CREDIT_CAP);
        const refund = base * P.creditRate;
        A.pen += tr; A.penFree += tr - base;
        if (P.reinvest) {
          A.refundPot += refund; A.refundPotPrin += refund;
        } else A.refundCash += refund;
        A.transfers.push({ m, tr, tax, base, refund });
        yr.tr += tr; yr.isaTaxA += tax; yr.creditBase += base; yr.refund += refund;
        A.isa = 0; A.isaPrin = 0; A.cycleOpen = m;
      }
      // (2) 연말 스냅샷
      if (m > 0 && m % 12 === 0 && !probe) {
        years.push({
          year: m / 12,
          aIsa: A.isa, aIsaPrin: A.isaPrin, aPen: A.pen, aRefund: A.refundPot + A.refundCash, aGen: A.gen.v,
          aTotal: A.isa + A.pen + A.refundPot + A.refundCash + A.gen.v,
          aPaid: A.paid,
          bIsa: B.isa, bIsaPrin: B.isaPrin, bGen: B.gen.v, bTotal: B.isa + B.gen.v, bPaid: B.paid,
          tr: yr.tr, isaTaxA: yr.isaTaxA, creditBase: yr.creditBase, refund: yr.refund,
          depA: yr.depA, depB: yr.depB,
        });
        resetYr();
      }
      if (m === endM) break;
      // (3) 납입
      const ea = da.get(m);
      if (ea) {
        let amt;
        if (sch.cash === 'flow') amt = ea.amt;
        else amt = A.gen.v > 0.5 ? genSell(A.gen, Math.min(ea.cap, ISA_TOTAL_LIMIT - A.isaPrin, genValueAfterTax(A.gen, P.genTax)), P.genTax) : 0;
        if (amt > 0.5) { A.isa += amt; A.isaPrin += amt; A.paid += amt; yr.depA += amt; lastDepositA = m; }
      }
      const eb = db.get(m);
      if (eb) {
        if (sch.cash === 'flow') {
          const room = Math.max(ISA_TOTAL_LIMIT - B.isaPrin, 0);
          const inIsa = Math.min(eb.amt, room);
          if (inIsa > 0.5) { B.isa += inIsa; B.isaPrin += inIsa; lastDepositB = m; }
          const out = eb.amt - inIsa;
          if (out > 0.5) { B.gen.v += out; B.gen.c += out; }
          B.paid += eb.amt; yr.depB += eb.amt;
        } else if (B.gen.v > 0.5) {
          const room = Math.max(ISA_TOTAL_LIMIT - B.isaPrin, 0);
          const amt = room > 0.5 ? genSell(B.gen, Math.min(eb.cap, room, genValueAfterTax(B.gen, P.genTax)), P.genTax) : 0;
          if (amt > 0.5) { B.isa += amt; B.isaPrin += amt; B.paid += amt; yr.depB += amt; lastDepositB = m; }
        }
      }
      // (4) 한 달 운용
      A.isa *= g1; A.pen *= g1; if (P.reinvest) A.refundPot *= g1; A.gen.v *= g1;
      B.isa *= g1; B.gen.v *= g1;
    }

    if (probe) return { lastDepositA, lastDepositB };

    // 최종 세후 (운용 종료 시점에 모두 찾는다고 가정)
    // 환급 재투자분: 연금저축에 세액공제 안 받은 납입으로 넣은 것으로 보고 원금 비과세·수익만 과세
    // (excelRefund=true면 엑셀처럼 재투자분 전체 비과세)
    const potGain = Math.max(A.refundPot - A.refundPotPrin, 0);
    const penTaxable = Math.max(A.pen - A.penFree, 0);
    const genA = genValueAfterTax(A.gen, P.genTax);
    const refundPensionTax = P.excelRefund ? 0 : potGain * P.pensionRate;
    const refundOtherTax = P.excelRefund ? 0 : potGain * P.otherRate;
    const aPension = A.penFree + penTaxable * (1 - P.pensionRate) + A.refundPot - refundPensionTax + A.refundCash + genA;
    const aOther = A.penFree + penTaxable * (1 - P.otherRate) + A.refundPot - refundOtherTax + A.refundCash + genA;
    const bGain = B.isa - B.isaPrin;
    const bIsaTax = Math.max(bGain - P.freeLimit, 0) * P.isaTax;
    const bGenAfter = genValueAfterTax(B.gen, P.genTax);
    const bFinal = B.isa - bIsaTax + bGenAfter;
    const totalRefund = A.transfers.reduce((s, t) => s + t.refund, 0);
    return {
      years, transfers: A.transfers,
      final: {
        aPension, aOther, b: bFinal,
        aPen: A.pen, aPenFree: A.penFree, aPenTaxable: penTaxable,
        aPensionTax: penTaxable * P.pensionRate + refundPensionTax, aOtherTax: penTaxable * P.otherRate + refundOtherTax,
        aRefundValue: A.refundPot + A.refundCash, totalRefund,
        aIsaTax: A.transfers.reduce((s, t) => s + t.tax, 0),
        bIsa: B.isa, bIsaPrin: B.isaPrin, bIsaTax, bGen: B.gen.v, bGenAfter,
        paid: A.paid,
      },
      lastDepositA, lastDepositB,
      fullyInA: lastDepositA, fullyInB: lastDepositB,
    };
  }

  const api = { simulate, ISA_YEAR_LIMIT, ISA_TOTAL_LIMIT, TRANSFER_CREDIT_CAP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IsaEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
