const E = require('./engine.js');
const won = x => Math.round(x).toLocaleString();
function chk(name, got, exp, tol = 2) {
  const ok = Math.abs(got - exp) <= tol; console.log((ok ? 'OK  ' : 'FAIL') + ' ' + name + ' got ' + won(got) + ' exp ' + won(exp));
  if (!ok) process.exitCode = 1;
}
// 1) 엑셀 기본값(연 1,000만·총 1억·8%·13.2%·환급 재투자) — 엑셀 캐시값과 대조
let r = E.simulate({ excelRefund: true });
console.log('H', r.H);
chk('A 연금수령(엑셀 G56)', r.final.aPension, 178953582);
chk('A 일시수령(엑셀 G57)', r.final.aOther, 170769255);
chk('B (엑셀 G58 − 잘못 더해진 A 환급액 2,084,356)', r.final.b, 176604914 - 2084356);
chk('A 연금저축 누적(엑셀 G52)', r.final.aPen, 180961390);
chk('A 비과세 재원(엑셀 G53)', r.final.aPenFree, 106558412);
chk('A 과세 재원(엑셀 G54)', r.final.aPenTaxable, 74402978);
chk('환급 누적(엑셀 K52)', r.final.aRefundValue, 2084356);
// 연차별 대조 (엑셀 W열 = 연금저축 잔액)
const W = {3:34758069,6:78543226,9:133699913,12:180961390};
for (const y in W) chk('연금저축 ' + y + '년차(W열)', r.years[y-1].aPen, W[y]);
// 2) 시나리오표(엑셀 A65~A71)
const sc = [
  ['① 1000만×10년 10%', {annual:1e7,total:1e8,r:0.10}, 205539707,194668306,201224536],
  ['② 300만×30년 10%', {annual:3e6,total:9e7,r:0.10}, 519823331,470925771,498198078],
  ['③ 500만×20년 10%', {annual:5e6,total:1e8,r:0.10}, 332918506,307044080,322306886],
  ['④ 2000만×5년 10%', {annual:2e7,total:1e8,r:0.10}, 144600312,141327938,143214821],
  ['⑤ 500만×20년 5%', {annual:5e6,total:1e8,r:0.05}, 179185782,170085248,174328741],
  ['⑥ 500만×20년 15%', {annual:5e6,total:1e8,r:0.15}, 639002781,578656757,620442779],
  ['⑦ 500만×20년 10% 16.5%', {annual:5e6,total:1e8,r:0.10,creditRate:0.165}, 333318299,307443873,322306886],
];
for (const [n,p,ea,eo,eb] of sc) {
  const x = E.simulate(Object.assign({excelRefund:true, reinvest:false}, p)); // 시나리오표는 환급액 단순합산
  console.log('--', n, 'H', x.H);
  chk(' A연금', x.final.aPension, ea, 5); chk(' A일시', x.final.aOther, eo, 5); chk(' B', x.final.b, eb, 5);
}
// 3) 정확 모드(환급 재투자분 수익 과세) 기본값
r = E.simulate({});
console.log('정확모드 A연금', won(r.final.aPension), 'A일시', won(r.final.aOther), 'B', won(r.final.b));
// 4) 목돈 모드 비교
for (const [P,H] of [[1e8,12],[2e8,15]]) {
  const y = E.simulate({mode:'lump', lump:P, schedule:'yearly', horizon:H});
  const f = E.simulate({mode:'lump', lump:P, schedule:'fast', horizon:H});
  console.log('목돈', P/1e8+'억', H+'년', '연1회 A', won(y.final.aPension), 'B', won(y.final.b), 'last', y.lastDepositA, '| 빠른 A', won(f.final.aPension), 'B', won(f.final.b), 'last', f.lastDepositA, 'minYears', y.minYears, f.minYears);
}
