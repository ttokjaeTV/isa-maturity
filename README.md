# ISA 만기 전략 계산기

ISA 3년 만기마다 해지해 연금저축으로 옮기는 전략(A)과 ISA 하나를 끝까지 유지하는 전략(B)의 세후 자산을 연차별로 비교하는 단독 HTML 계산기입니다.

- 사이트: https://ttokjaetv.github.io/isa-maturity/
- 넣는 방식 3가지: 매년 저축(적립식) / 목돈 한 번에(거치식) / 목돈 + 매년 저축
- 한도 규칙: 개설 달에 그 해 2,000만원, 매년 1월 2,000만원 추가(이월), 계좌당 1억원. 한도를 넘는 돈은 일반계좌에서 대기 후 이동
- 목돈이 있는 방식: 12월 개설·만기 즉시 재가입(연도 경계 한도 활용) vs 1월 개설 비교
- ISA 유형(200만/400만), 세액공제율(13.2%/16.5%), 연금 수령 나이(5.5/4.4/3.3%), 환급액 재투자 선택

## 구조

```
index.html          빌드 결과 (GitHub Pages가 이 파일을 보여줌)
src/engine.js       계산 엔진 (브라우저·Node 공용)
src/template.html   화면
src/build.py        template + engine → index.html
src/test.js         원본 엑셀(ISA 만기 전략 시뮬레이터) 값과 대조 테스트
```

## 수정 방법

1. `src/engine.js` 또는 `src/template.html` 수정
2. `python src/build.py` 로 index.html 다시 생성
3. `node src/test.js` 로 엑셀 대조 테스트 (모두 OK인지 확인)
4. GitHub Desktop에서 Commit → Push

## 원본 엑셀과의 차이

- 엑셀 전략B 세후총자산(AE열)에 전략A의 연금 전환 환급액(AX열)이 더해져 있던 오류를 바로잡았습니다. 전략B는 연금으로 옮기지 않으므로 환급이 없습니다.
- 환급액 재투자분의 운용수익에 연금소득세를 매깁니다(엑셀은 전액 비과세). `excelRefund: true` 옵션으로 엑셀과 같은 값을 낼 수 있고, test.js가 그 방식으로 엑셀 값과 원 단위까지 대조합니다.
