# SafeNight 점수 계산

## 기존 점수식

센서 한 곳의 한 시간 관측을 기준으로 조도·소음·소음 변동에 따라 점수를 깎고, 반경 25m에 기록된 시설 수에 따라 점수를 더했다. $L$은 평균 조도(lx), $n$은 평균 소음(dB)이다. 아래에서 $c(z)=\min(100,\max(0,z))$는 값을 0~100점으로 제한한다.

$$
I = c\!\left(100-\frac{L}{3}\right),
\qquad v = \frac{n_{\max}-n_{\min}}{4}
$$

$$
N =
\begin{cases}
c(100-2.5n), & n < 40 \\[3pt]
\dfrac{20}{30}(n-40), & 40 \le n \le 70 \\[5pt]
\min\!\left(100,\,20+\dfrac{80}{40}(n-70)\right), & n > 70
\end{cases}
$$

$$
T =
\begin{cases}
50, & n=0 \\[3pt]
c\!\left(50-\dfrac{100v}{n+10^{-5}}\right), & n\ne 0
\end{cases}
$$

CCTV·가로등·보안등의 설치 기록 수를 각각 $k_C, k_G, k_B$라 두고 세 시설의 기여분을 구했다.

$$
C=\min(100,25k_C),\quad G=\min(100,20k_G),\quad B=\min(100,30k_B)
$$

$$
S=c\!\left(100-0.30I-0.15N-0.10T+0.25C+0.15G+0.05B\right)
$$

시설 수는 공개 자료에 나온 좌표 행 수다. 가중치와 소음 구간은 프로젝트에서 정했다. 소음 변동은 최대·최소 차이의 4분의 1로 잡았고, 이 값이 커질수록 원식의 소음 변동 차감분이 줄어든다. 관측값과 시설 수가 0 이상일 때 환경점수 $S$의 범위는 50~100점이다. [학습 자료](../backend/data/training/README.md) · [원본 자료 기록](../backend/data/training/environment_proxy.provenance.json)

## 연구에서 비교한 점수

기존 환경점수를 $R = 100 - S$로 뒤집어 값이 클수록 환경 부담이 큰 위험점수를 만들었다. 랜덤 포레스트의 예측을 조도, 소음, CCTV, 가로등, 보안등의 다섯 부분의존도(PDP) 곡선으로 나눴다. 조도와 소음은 각각 같은 관측에 속한 측정값을 묶어 바꿨다. 시설 곡선은 수량을 늘렸을 때 위험점수가 같거나 낮아지도록 맞췄다.

$$
R_{\mathrm{new}}(x)
= \operatorname{clip}_{[0,50]}\!\left[
  \alpha + \sum_{B} w_B\,\widetilde{P}_B(x_B)
\right],
\qquad w_B \ge 0
$$

$x_B$는 묶음 $B$에 속한 입력값이고, $\widetilde{P}_B(x_B)$는 해당 PDP 곡선에서 기준 평균을 뺀 기여분이다. $\alpha$는 절편, $w_B$는 묶음별 가중치다. 위험점수를 환경점수로 환산할 때는 $S_{\mathrm{new}}(x)=100-R_{\mathrm{new}}(x)$를 쓴다.

가중치는 보정용 좌표 134곳에서 0 이상의 값으로 추정했다. 이 중 가로등이 기록된 곳이 없어 가로등 계수는 1로 고정했다. 평가용 135곳에서 원래 식과의 평균 절대 오차는 RF 0.6654점, 보정한 점수 0.4025점이었다. [분석 노트북](../notebooks/safenight-pdp-score-research.ipynb) · [방법별 오차](notebook-results/results.csv)

## 지도에서 계산하는 점수

지도에서는 센서의 평균 조도와 평균 소음으로 기존 `rule_index`를 추정한다. 2025년 10월 12일의 3,230건(센서 652곳)을 사용했고, 센서 131곳을 따로 떼어 평가했다. 트리 114개, 최대 깊이 18, 말단 최소 표본 3개일 때 평균 절대 오차는 8.28점이었다. 학습 자료의 중앙값을 일괄 적용한 오차는 7.95점이었다. [학습 코드](../backend/src/safenight_backend/rf/training.py) · [평가 결과](model-analysis/metrics.json) · [모델 설정](../cloud/app/server/data/manifest.json)

| 검사 | 현재 기준 | 실패 시 처리 |
|---|---|---|
| 모델 파일 | SHA-256·버전·트리 구조·manifest 일치 | 로딩 거부 |
| 관측·필수값 | 관측·좌표·조도·소음 존재 | DATA_UNAVAILABLE |
| 관측 시각 | 관측 시각이 현재부터 과거 30시간 이내 | 미래는 UNSUPPORTED, 초과는 STALE |
| 입력 계약 | environment-v1 일치 | SCHEMA_MISMATCH |
| 센서·위치 | 학습 센서 ID이며 해당 학습 위치에서 250m 이내 | UNSUPPORTED |
| 입력 범위 | 조도 0~467 lux·소음 35~74 dB | UNSUPPORTED |
| 추론 출력 | 유한한 0~100 값 | 정상은 SCORED, 잘못된 출력은 MODEL_ERROR |

점수를 보류하면 API는 `score: null`과 사유를 반환한다. 응답에는 관측 시각과 계산에 사용한 모델·입력 버전이 남는다. [Python 점수 계산](../backend/src/safenight_backend/serving/service.py) · [지도 서버의 점수 계산](../cloud/app/server/serving.ts)

## 검색한 장소의 참고점수

검색 좌표 반경 1.5km에서 유효한 센서를 가까운 순으로 최대 8곳 골랐다. 거리가 가까울수록 가중치를 크게 두고, 25m 이내에는 같은 가중치를 준다.

센서 $i$까지의 거리를 $d_i$(m), 그 센서의 점수를 $s_i$라 두면 장소 참고점수는 다음과 같다.

$$
w_i=\frac{1}{\max(25,d_i)^2},
\qquad
S_{\mathrm{place}}=\frac{\sum_i w_i s_i}{\sum_i w_i}
$$

송파구·서초구의 시설은 검색 위치 반경 1km 안의 설치 기록을 집계한다. 인구는 서울시 집계 구역별 추정치다. 화면에는 두 자료를 센서 점수와 별도로 표시한다. [센서 선택과 가중치](../cloud/app/server/location-assessment.ts) · [시설 집계](../cloud/app/server/context-data.ts) · [인구 조회](../cloud/app/server/population.ts)
