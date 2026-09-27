// 스플렌더 대결 카드 데이터 (보석 카드 67장 + 왕실 카드 4장)
// 4개의 독립 출처(BGA 카드 이미지, splendortactics 카드 스캔, BGG 카드 목록, 여러 오픈소스 구현)를 교차 확인한 값입니다.
// id: 레벨 + 색 글자(W 흰색, U 파랑, G 초록, R 빨강, K 검정, J 조커, N 보너스 없음) + 번호
(function () {
  var CARDS = [
    // ── 레벨 1 ──
    { id: "1W1", level: 1, bonus: "white", bonusCount: 1, points: 0, crowns: 0, ability: null, cost: { white: 0, blue: 1, green: 1, red: 1, black: 1, pearl: 0 } },
    { id: "1W2", level: 1, bonus: "white", bonusCount: 1, points: 0, crowns: 1, ability: null, cost: { white: 0, blue: 3, green: 0, red: 0, black: 0, pearl: 0 } },
    { id: "1W3", level: 1, bonus: "white", bonusCount: 1, points: 0, crowns: 0, ability: "extra_turn", cost: { white: 0, blue: 2, green: 2, red: 0, black: 0, pearl: 1 } },
    { id: "1W4", level: 1, bonus: "white", bonusCount: 1, points: 0, crowns: 0, ability: "bonus_token", cost: { white: 0, blue: 0, green: 0, red: 2, black: 2, pearl: 0 } },
    { id: "1W5", level: 1, bonus: "white", bonusCount: 1, points: 1, crowns: 0, ability: null, cost: { white: 0, blue: 0, green: 2, red: 3, black: 0, pearl: 0 } },
    { id: "1U1", level: 1, bonus: "blue", bonusCount: 1, points: 0, crowns: 0, ability: null, cost: { white: 1, blue: 0, green: 1, red: 1, black: 1, pearl: 0 } },
    { id: "1U2", level: 1, bonus: "blue", bonusCount: 1, points: 0, crowns: 1, ability: null, cost: { white: 0, blue: 0, green: 3, red: 0, black: 0, pearl: 0 } },
    { id: "1U3", level: 1, bonus: "blue", bonusCount: 1, points: 0, crowns: 0, ability: "extra_turn", cost: { white: 0, blue: 0, green: 2, red: 2, black: 0, pearl: 1 } },
    { id: "1U4", level: 1, bonus: "blue", bonusCount: 1, points: 0, crowns: 0, ability: "bonus_token", cost: { white: 2, blue: 0, green: 0, red: 0, black: 2, pearl: 0 } },
    { id: "1U5", level: 1, bonus: "blue", bonusCount: 1, points: 1, crowns: 0, ability: null, cost: { white: 0, blue: 0, green: 0, red: 2, black: 3, pearl: 0 } },
    { id: "1G1", level: 1, bonus: "green", bonusCount: 1, points: 0, crowns: 0, ability: null, cost: { white: 1, blue: 1, green: 0, red: 1, black: 1, pearl: 0 } },
    { id: "1G2", level: 1, bonus: "green", bonusCount: 1, points: 0, crowns: 1, ability: null, cost: { white: 0, blue: 0, green: 0, red: 3, black: 0, pearl: 0 } },
    { id: "1G3", level: 1, bonus: "green", bonusCount: 1, points: 0, crowns: 0, ability: "extra_turn", cost: { white: 0, blue: 0, green: 0, red: 2, black: 2, pearl: 1 } },
    { id: "1G4", level: 1, bonus: "green", bonusCount: 1, points: 0, crowns: 0, ability: "bonus_token", cost: { white: 2, blue: 2, green: 0, red: 0, black: 0, pearl: 0 } },
    { id: "1G5", level: 1, bonus: "green", bonusCount: 1, points: 1, crowns: 0, ability: null, cost: { white: 3, blue: 0, green: 0, red: 0, black: 2, pearl: 0 } },
    { id: "1R1", level: 1, bonus: "red", bonusCount: 1, points: 0, crowns: 0, ability: null, cost: { white: 1, blue: 1, green: 1, red: 0, black: 1, pearl: 0 } },
    { id: "1R2", level: 1, bonus: "red", bonusCount: 1, points: 0, crowns: 1, ability: null, cost: { white: 0, blue: 0, green: 0, red: 0, black: 3, pearl: 0 } },
    { id: "1R3", level: 1, bonus: "red", bonusCount: 1, points: 0, crowns: 0, ability: "extra_turn", cost: { white: 2, blue: 0, green: 0, red: 0, black: 2, pearl: 1 } },
    { id: "1R4", level: 1, bonus: "red", bonusCount: 1, points: 0, crowns: 0, ability: "bonus_token", cost: { white: 0, blue: 2, green: 2, red: 0, black: 0, pearl: 0 } },
    { id: "1R5", level: 1, bonus: "red", bonusCount: 1, points: 1, crowns: 0, ability: null, cost: { white: 2, blue: 3, green: 0, red: 0, black: 0, pearl: 0 } },
    { id: "1K1", level: 1, bonus: "black", bonusCount: 1, points: 0, crowns: 0, ability: null, cost: { white: 1, blue: 1, green: 1, red: 1, black: 0, pearl: 0 } },
    { id: "1K2", level: 1, bonus: "black", bonusCount: 1, points: 0, crowns: 1, ability: null, cost: { white: 3, blue: 0, green: 0, red: 0, black: 0, pearl: 0 } },
    { id: "1K3", level: 1, bonus: "black", bonusCount: 1, points: 0, crowns: 0, ability: "extra_turn", cost: { white: 2, blue: 2, green: 0, red: 0, black: 0, pearl: 1 } },
    { id: "1K4", level: 1, bonus: "black", bonusCount: 1, points: 0, crowns: 0, ability: "bonus_token", cost: { white: 0, blue: 0, green: 2, red: 2, black: 0, pearl: 0 } },
    { id: "1K5", level: 1, bonus: "black", bonusCount: 1, points: 1, crowns: 0, ability: null, cost: { white: 0, blue: 2, green: 3, red: 0, black: 0, pearl: 0 } },
    { id: "1J1", level: 1, bonus: "joker", bonusCount: 1, points: 1, crowns: 0, ability: null, cost: { white: 0, blue: 0, green: 0, red: 0, black: 4, pearl: 1 } },
    { id: "1J2", level: 1, bonus: "joker", bonusCount: 1, points: 0, crowns: 1, ability: null, cost: { white: 4, blue: 0, green: 0, red: 0, black: 0, pearl: 1 } },
    { id: "1J3", level: 1, bonus: "joker", bonusCount: 1, points: 1, crowns: 0, ability: null, cost: { white: 0, blue: 2, green: 0, red: 2, black: 1, pearl: 1 } },
    { id: "1J4", level: 1, bonus: "joker", bonusCount: 1, points: 1, crowns: 0, ability: null, cost: { white: 2, blue: 0, green: 2, red: 0, black: 1, pearl: 1 } },
    { id: "1N1", level: 1, bonus: null, bonusCount: 0, points: 3, crowns: 0, ability: null, cost: { white: 0, blue: 0, green: 0, red: 4, black: 0, pearl: 1 } },
    // ── 레벨 2 ──
    { id: "2W1", level: 2, bonus: "white", bonusCount: 1, points: 2, crowns: 1, ability: null, cost: { white: 0, blue: 0, green: 2, red: 2, black: 2, pearl: 1 } },
    { id: "2W2", level: 2, bonus: "white", bonusCount: 1, points: 1, crowns: 0, ability: "steal", cost: { white: 0, blue: 4, green: 0, red: 3, black: 0, pearl: 0 } },
    { id: "2W3", level: 2, bonus: "white", bonusCount: 1, points: 2, crowns: 0, ability: "privilege", cost: { white: 4, blue: 0, green: 0, red: 0, black: 2, pearl: 1 } },
    { id: "2W4", level: 2, bonus: "white", bonusCount: 2, points: 1, crowns: 0, ability: null, cost: { white: 0, blue: 5, green: 2, red: 0, black: 0, pearl: 0 } },
    { id: "2U1", level: 2, bonus: "blue", bonusCount: 1, points: 2, crowns: 1, ability: null, cost: { white: 2, blue: 0, green: 0, red: 2, black: 2, pearl: 1 } },
    { id: "2U2", level: 2, bonus: "blue", bonusCount: 1, points: 1, crowns: 0, ability: "steal", cost: { white: 0, blue: 0, green: 4, red: 0, black: 3, pearl: 0 } },
    { id: "2U3", level: 2, bonus: "blue", bonusCount: 1, points: 2, crowns: 0, ability: "privilege", cost: { white: 2, blue: 4, green: 0, red: 0, black: 0, pearl: 1 } },
    { id: "2U4", level: 2, bonus: "blue", bonusCount: 2, points: 1, crowns: 0, ability: null, cost: { white: 0, blue: 0, green: 5, red: 2, black: 0, pearl: 0 } },
    { id: "2G1", level: 2, bonus: "green", bonusCount: 1, points: 2, crowns: 1, ability: null, cost: { white: 2, blue: 2, green: 0, red: 0, black: 2, pearl: 1 } },
    { id: "2G2", level: 2, bonus: "green", bonusCount: 1, points: 1, crowns: 0, ability: "steal", cost: { white: 3, blue: 0, green: 0, red: 4, black: 0, pearl: 0 } },
    { id: "2G3", level: 2, bonus: "green", bonusCount: 1, points: 2, crowns: 0, ability: "privilege", cost: { white: 0, blue: 2, green: 4, red: 0, black: 0, pearl: 1 } },
    { id: "2G4", level: 2, bonus: "green", bonusCount: 2, points: 1, crowns: 0, ability: null, cost: { white: 0, blue: 0, green: 0, red: 5, black: 2, pearl: 0 } },
    { id: "2R1", level: 2, bonus: "red", bonusCount: 1, points: 2, crowns: 1, ability: null, cost: { white: 2, blue: 2, green: 2, red: 0, black: 0, pearl: 1 } },
    { id: "2R2", level: 2, bonus: "red", bonusCount: 1, points: 1, crowns: 0, ability: "steal", cost: { white: 0, blue: 3, green: 0, red: 0, black: 4, pearl: 0 } },
    { id: "2R3", level: 2, bonus: "red", bonusCount: 1, points: 2, crowns: 0, ability: "privilege", cost: { white: 0, blue: 0, green: 2, red: 4, black: 0, pearl: 1 } },
    { id: "2R4", level: 2, bonus: "red", bonusCount: 2, points: 1, crowns: 0, ability: null, cost: { white: 2, blue: 0, green: 0, red: 0, black: 5, pearl: 0 } },
    { id: "2K1", level: 2, bonus: "black", bonusCount: 1, points: 2, crowns: 1, ability: null, cost: { white: 0, blue: 2, green: 2, red: 2, black: 0, pearl: 1 } },
    { id: "2K2", level: 2, bonus: "black", bonusCount: 1, points: 1, crowns: 0, ability: "steal", cost: { white: 4, blue: 0, green: 3, red: 0, black: 0, pearl: 0 } },
    { id: "2K3", level: 2, bonus: "black", bonusCount: 1, points: 2, crowns: 0, ability: "privilege", cost: { white: 0, blue: 0, green: 0, red: 2, black: 4, pearl: 1 } },
    { id: "2K4", level: 2, bonus: "black", bonusCount: 2, points: 1, crowns: 0, ability: null, cost: { white: 5, blue: 2, green: 0, red: 0, black: 0, pearl: 0 } },
    { id: "2J1", level: 2, bonus: "joker", bonusCount: 1, points: 2, crowns: 0, ability: null, cost: { white: 0, blue: 0, green: 6, red: 0, black: 0, pearl: 1 } },
    { id: "2J2", level: 2, bonus: "joker", bonusCount: 1, points: 0, crowns: 2, ability: null, cost: { white: 0, blue: 0, green: 6, red: 0, black: 0, pearl: 1 } },
    { id: "2J3", level: 2, bonus: "joker", bonusCount: 1, points: 0, crowns: 2, ability: null, cost: { white: 0, blue: 6, green: 0, red: 0, black: 0, pearl: 1 } },
    { id: "2N1", level: 2, bonus: null, bonusCount: 0, points: 5, crowns: 0, ability: null, cost: { white: 0, blue: 6, green: 0, red: 0, black: 0, pearl: 1 } },
    // ── 레벨 3 ──
    { id: "3W1", level: 3, bonus: "white", bonusCount: 1, points: 3, crowns: 2, ability: null, cost: { white: 0, blue: 3, green: 0, red: 5, black: 3, pearl: 1 } },
    { id: "3W2", level: 3, bonus: "white", bonusCount: 1, points: 4, crowns: 0, ability: null, cost: { white: 6, blue: 2, green: 0, red: 0, black: 2, pearl: 0 } },
    { id: "3U1", level: 3, bonus: "blue", bonusCount: 1, points: 3, crowns: 2, ability: null, cost: { white: 3, blue: 0, green: 3, red: 0, black: 5, pearl: 1 } },
    { id: "3U2", level: 3, bonus: "blue", bonusCount: 1, points: 4, crowns: 0, ability: null, cost: { white: 2, blue: 6, green: 2, red: 0, black: 0, pearl: 0 } },
    { id: "3G1", level: 3, bonus: "green", bonusCount: 1, points: 3, crowns: 2, ability: null, cost: { white: 5, blue: 3, green: 0, red: 3, black: 0, pearl: 1 } },
    { id: "3G2", level: 3, bonus: "green", bonusCount: 1, points: 4, crowns: 0, ability: null, cost: { white: 0, blue: 2, green: 6, red: 2, black: 0, pearl: 0 } },
    { id: "3R1", level: 3, bonus: "red", bonusCount: 1, points: 3, crowns: 2, ability: null, cost: { white: 0, blue: 5, green: 3, red: 0, black: 3, pearl: 1 } },
    { id: "3R2", level: 3, bonus: "red", bonusCount: 1, points: 4, crowns: 0, ability: null, cost: { white: 0, blue: 0, green: 2, red: 6, black: 2, pearl: 0 } },
    { id: "3K1", level: 3, bonus: "black", bonusCount: 1, points: 3, crowns: 2, ability: null, cost: { white: 3, blue: 0, green: 5, red: 3, black: 0, pearl: 1 } },
    { id: "3K2", level: 3, bonus: "black", bonusCount: 1, points: 4, crowns: 0, ability: null, cost: { white: 2, blue: 0, green: 0, red: 2, black: 6, pearl: 0 } },
    { id: "3J1", level: 3, bonus: "joker", bonusCount: 1, points: 3, crowns: 0, ability: "extra_turn", cost: { white: 0, blue: 0, green: 0, red: 8, black: 0, pearl: 0 } },
    { id: "3J2", level: 3, bonus: "joker", bonusCount: 1, points: 0, crowns: 3, ability: null, cost: { white: 0, blue: 0, green: 0, red: 0, black: 8, pearl: 0 } },
    { id: "3N1", level: 3, bonus: null, bonusCount: 0, points: 6, crowns: 0, ability: null, cost: { white: 8, blue: 0, green: 0, red: 0, black: 0, pearl: 0 } },
  ];

  var ROYALS = [
    { id: "R1", points: 2, ability: "steal" },
    { id: "R2", points: 2, ability: "extra_turn" },
    { id: "R3", points: 2, ability: "privilege" },
    { id: "R4", points: 3, ability: null },
  ];

  var SDCards = { CARDS: CARDS, ROYALS: ROYALS };
  if (typeof module !== "undefined" && module.exports) module.exports = SDCards;
  else window.SDCards = SDCards;
})();
