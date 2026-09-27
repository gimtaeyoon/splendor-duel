# Splendor Duel — rules reference (for implementation)

Paraphrased from the official rulebook (Space Cowboys 2022, p.2-12), publisher-verified Dized rules + FAQ, and the BGA game help. Page refs are to the rulebook.

## setup

COMPONENTS (rulebook p.2): 1 Victory tile; 67 Jewel cards in 3 levels; 1 bag; 3 Privilege scrolls; 25 tokens = 4 of each of 5 gem colours (blue, white, green, black, red; 20 gems), 2 Pearls and 3 Gold; 1 board with 5x5 = 25 spaces; 4 Royal cards. The rulebook does not print the per-level card split. From the card database and two independent card datasets: Level 1 = 30, Level 2 = 24, Level 3 = 13 (sum 67).
SETUP STEPS (in this order, p.2):
1) Shuffle the three level decks separately and stack them as a column with Level 1 at the bottom (Level 3 on top).
2) Reveal 3 Level-3, 4 Level-2 and 5 Level-1 cards face up. These 12 cards form the pyramid below the Victory tile.
3) Put the board below the pyramid and fill it randomly with ALL 25 tokens, starting at the centre space and following the printed spiral. Result: the board is completely full and the BAG IS EMPTY at game start, so Replenish is impossible until tokens have been spent or discarded. Implementation: shuffle the 25 tokens and assign them to spiral positions 1..25.
4) Put the 3 Privileges above the board as the common supply.
5) Put all 4 Royal cards face up below the board. All 4 are available; there is no deck and no random subset.
6) Pick the first player at random. The OTHER player takes 1 Privilege from the supply. Start state: supply 2, first player 0, second player 1.

## turnStructure

Order of a turn (p.4 and the player aid on p.12):
(a) OPTIONAL 1, Use Privilege(s).
(b) OPTIONAL 2, Replenish the board.
You may do neither, one or both, but only in this fixed order and only BEFORE the mandatory action.
(c) Exactly ONE mandatory action: take up to 3 tokens, OR take 1 Gold + reserve 1 card, OR purchase 1 card.
(d) If a card was gained, resolve its ability, then check Crowns (3rd or 6th Crown -> take 1 Royal and resolve its ability).
(e) End of turn: token limit (discard down to 10), then the victory check.
(f) Next turn: the opponent's, or yours again if you gained an extra-turn effect.
Dized clarifications:
- The optional actions cannot be done in any order. Privilege scrolls always come first; only then may you replenish.
- Using privileges must be the very first thing you do in your turn. It cannot be done at any other point.
- Using a privilege does not end your turn.
- You may use more than one privilege in a turn.
There is no optional action after the mandatory action. Each optional action happens at most once per turn, but one Use Privilege action can return several scrolls. An extra turn is a full new turn, so it has its own optional-action window.

## optionalActions

1 - USE A PRIVILEGE (p.4): Return one or more of your Privileges to the supply above the board. For EACH one returned, take 1 Gem or Pearl token of your choice from anywhere on the board. There is no adjacency or line requirement. It can never take Gold (confirmed by the Dized FAQ). Pearls may be taken (Dized FAQ). This never gives the opponent a Privilege, even if you take 3 of one colour or both Pearls this way; that penalty belongs only to the mandatory take-tokens action. Implementation: allow returning k scrolls only when there are at least k Gem/Pearl tokens on the board. Tokens taken this way can push you above 10; the limit is only checked at the end of the turn.
2 - REPLENISH THE BOARD (p.4): Not allowed if the bag is empty. Otherwise mix the bag and place its tokens on EMPTY spaces one at a time, starting at the centre space and following the spiral order, skipping occupied spaces, until the bag is empty. Then the OPPONENT takes 1 Privilege, using the standard acquisition rule (see privilegeRules). This is allowed any time the bag is non-empty; the board does not have to be nearly empty. It can be done at most once per turn and only after any privilege use.
Also on p.4: your tokens must always be visible to your opponent (open information). The Dized FAQ confirms you cannot hide tokens.

## mandatoryActions

You must perform exactly one of the following (p.5).
A) TAKE UP TO 3 TOKENS. Legal if at least 1 Gem or Pearl token is on the board. See tokenLineRules.
B) TAKE 1 GOLD AND RESERVE 1 JEWEL CARD. Illegal if there is no Gold on the board, or if you already hold 3 reserved cards. See reserveRules.
C) PURCHASE 1 JEWEL CARD, from the pyramid or from your own reserve. See purchaseRules.
SPECIAL CASE (p.5): if you cannot perform any of the three, you must perform the Replenish optional action before choosing your mandatory action. See cantAct.
Player aid (p.12) summary:
- Take up to 3 adjacent non-Gold tokens in an uninterrupted row, column or diagonal. If the 3 are identical or 2 of them are Pearls, the opponent takes 1 Privilege.
- Take 1 Gold, then reserve 1 card. Impossible with no Gold on the board or with 3 reserved cards.
- Buy 1 pyramid card or 1 reserved card, paying the cost minus the bonuses you already have.

## tokenLineRules

From p.5 and the Dized page.
- Take 1, 2 or 3 Gem and/or Pearl tokens from the board. You must take at least 1; the rulebook explicitly allows 2 or even a single token, and the Dized FAQ says you can take just one.
- The tokens must be ADJACENT and form an UNINTERRUPTED straight line: horizontal, vertical or diagonal. Both diagonal directions are allowed.
- Two tokens must be neighbours in any of the 8 directions. Three tokens must be 3 consecutive cells on one straight line. An L-shape or a bent line is not allowed.
- A GOLD token or an EMPTY space breaks a line. The rulebook's red examples: a vertical group interrupted by a Gold token, and a horizontal group interrupted by an empty space. You cannot skip over them.
- Gold can NEVER be taken by this action (confirmed in the Dized FAQ). Taking an Optional Privilege action or a Reserve action is the only other way tokens leave the board, and only Reserve takes Gold.
- Colours may be mixed freely. Pearls count as normal tokens in the line.
PENALTY: if this action takes 3 tokens of the SAME gem colour, OR takes both Pearls ("2 Pearls", whether you took 2 tokens or 3), the OPPONENT takes 1 Privilege, using the standard rule: from the supply, else from you, else nothing. The penalty is at most 1 Privilege per action; both conditions cannot coincide because only 2 Pearls exist. The penalty applies only to this mandatory action. It does not apply to tokens gained through privileges, the take-matching-token ability, stealing, or Royal cards.
GOLD in general: the Take 1 Gold + Reserve action is the only way to gain Gold (p.6 and Reminders). Privileges cannot take Gold, and the steal ability cannot take Gold.

## purchaseRules

From p.6-7.
- Choose a face-up pyramid card or one of YOUR reserved cards.
- Pay its cost, printed bottom-left, in tokens. Place the card face up in front of you.
- Gold is wild: each Gold replaces any one Gem or Pearl. The player may choose to spend Gold even while holding the matching token.
- ALL spent tokens, Gold included, go into the BAG.
BONUSES: each purchased card gives its bonus or bonuses (top right). Each bonus permanently reduces that colour's cost by 1 on all future purchases. Some cards have 2 bonuses and reduce by 2. Effective cost per colour = max(0, printed cost - your bonuses of that colour). You cannot go below 0 and you never gain tokens from surplus bonuses. There are NO Pearl bonuses, so Pearl costs are never reduced.
Rulebook example: bonuses 3 red, 2 blue, 1 green; a card costing 3 blue, 5 red, 3 black, 1 Pearl costs 1 blue, 2 red, 3 black, 1 Pearl.
TABLEAU: keep purchased cards sorted by bonus colour, overlapping, with the tops (points, Crowns, bonuses) visible.
PYRAMID REFILL: when you buy a pyramid card, refill that slot from the matching level's deck. The reserve section says that if the deck is empty the slot is not refilled; apply the same to purchases.
AFTER BUYING: resolve the card's ability (if any), then the Crown check (3rd or 6th Crown -> Royal). Abilities never trigger for reserved or pyramid cards until they are bought.
RESTRICTION: a joker card (copy-colour ability) cannot be bought unless you own at least one card with a bonus. See jokerRules.
Cards with NO bonus: per the card data, one points-only card per level (L1: 3 points; L2: 5 points; L3: 6 points). They give points only.

## reserveRules

From p.6 and Dized.
- NOT allowed if there is no Gold token on the board, or if you already hold 3 reserved cards. You therefore CANNOT reserve without Gold on the board, and you never reserve without taking Gold in the base game.
- Sequence: FIRST take 1 Gold token of your choice from the board (no line or adjacency rule). THEN you must do one of two things:
  (i) take any 1 face-up card from the pyramid, OR
  (ii) draw the TOP card of one of the 3 level decks, blind. You see it after drawing; the opponent does not.
- Maximum 3 reserved cards at any time. Reserved cards are kept secret from the opponent (face down or in hand), and you may look at your own at any time (Dized FAQ: yes and secret).
- Reserved cards have no effect until purchased. Having reserved cards at game end carries no penalty (Dized FAQ: nothing happens).
- The only way to play a reserved card is the Purchase action (Dized FAQ).
- A card reserved from the pyramid is replaced from the matching deck. If that deck is empty, the slot stays empty.
- You can only draw from a non-empty deck.
- The Gold taken counts toward the 10-token limit at the end of the turn.

## cardAbilities

An ability resolves immediately when you gain the card: on purchase for Jewel cards, when taken for Royal cards (p.8). Ability types:
1) EXTRA TURN (circular arrows): after this turn ends, take another turn at once. This turn's end-of-turn steps (discard to 10, victory check) happen first; then you play a complete new turn with optional actions and a mandatory action.
2) JOKER / COPY COLOUR (grey gem icon): place this card overlapping one of your Jewel cards that has a bonus. Its bonus counts as that card's colour. If you have no card with a bonus, you cannot purchase it. See jokerRules.
3) TAKE A MATCHING TOKEN (faceted gem icon): take 1 token of this card's colour from anywhere on the board, with no line or adjacency rule. If none of that colour is on the board, ignore it. It does not take from the bag or from the opponent, and it does not trigger the take-3-same penalty.
4) PRIVILEGE (scroll icon): take 1 Privilege from the supply. If the supply is empty, take 1 from the opponent. If you already have all 3, nothing happens.
5) STEAL (hand icon): take 1 Gem or Pearl token of your choice from the opponent. If the opponent has none, ignore it; this includes an opponent holding only Gold. You can never take Gold.
Dized adds that "Some jewel cards and Royal cards have abilities".
ROYAL CARDS (from the Dized image of the 4 cards): 2 points + Steal; 2 points + Extra turn; 2 points + Privilege; 3 points with no ability. Rulebook example: Julie's Royal gives 1 Privilege and 2 points.
CARD DISTRIBUTION (unofficial card data, consistent with the images I checked):
- L1 (30): per colour, 5 cards = 3 with no ability, 1 extra turn, 1 take-matching-token. Plus 4 jokers and 1 points-only card.
- L2 (24): per colour, 4 cards = 1 steal, 1 privilege, 1 plain, 1 double-bonus plain. Plus 3 jokers and 1 points-only card.
- L3 (13): per colour, 2 plain cards. Plus 1 joker, 1 joker + extra turn (the only card with 2 abilities; resolve the joker placement, then the extra turn), and 1 points-only card.
- Total Crowns across all Jewel cards: 28.
CHAINS: the player aid order is: 3) resolve the new card's ability, 4) 3rd or 6th Crown -> take a Royal and resolve its ability, 5) token limit, 6) victory. Per the card data, NO card with an extra-turn, privilege, steal or take-token ability carries Crowns. So the only same-purchase chain is joker placement -> Royal (+ Royal ability), or the L3 joker's placement -> extra turn. A Royal's ability resolves fully, e.g. a Royal Privilege can take one from the opponent. Tokens gained from abilities count toward the 10-token limit checked afterwards.

## jokerRules

From p.8, Dized and the FAQ.
- A joker (grey card with a multicolour bonus and the copy-colour ability) must be placed overlapping one of your Jewel cards that HAS a bonus. Its single bonus is treated as that card's colour, and it joins that colour's group or column. The player chooses which colour when they have several.
- If you own no card with a bonus, you cannot purchase a joker. You may still reserve one. The Reminders line in the rulebook omits the icon but means the joker.
- A joker gives 1 bonus of the copied colour. Placing it on a double-bonus card does not give 2.
- Placing a joker on a card with an ability does NOT trigger that ability (Dized FAQ): it only adds another bonus of that colour to the column.
- COLOUR VICTORY: a joker counts as the colour of the group it sits in, so its points add to that colour's total (rulebook victory condition 3 and the Dized example: red column 2+1(joker)+1+2+4 = 10).
- Points-only cards with NO bonus are different (Dized FAQ): they are not their own colour and do NOT count toward the 10-points-in-one-colour condition, but they DO count toward 20 total points. They also cannot serve as the host a joker overlaps, since they have no bonus.
- Joker cards (per card data): L1 has 4 (costs such as 4 black + 1 Pearl; one has a Crown and 0 points); L2 has 3 (6 of one colour + 1 Pearl; two have 2 Crowns); L3 has 2 (8 of one colour; one with 3 Crowns, one with 3 points + extra turn).

## privilegeRules

COUNT: exactly 3 Privilege scrolls in the game. Start: supply 2, second player 1, first player 0.
WAYS TO GAIN ONE (Dized Privilege Scrolls page):
- At setup, the non-starting player gets one.
- A card ability (Privilege cards; there are 5 L2 cards with it).
- The Royal Privilege card.
- Your opponent takes 3 same-colour tokens or 2 Pearls with the take-tokens action.
- Your opponent replenishes the board.
ACQUISITION RULE (p.4 Important, repeated in Reminders): when you must take a Privilege and none are left in the supply, take 1 from your opponent instead. The rulebook's own wording for the last case is "If you already have all 3 Privileges, nothing happens."
Algorithm: gain(p) = if supply > 0 then supply-- and p++; else if opponent(p) > 0 then opponent-- and p++; else nothing, because p already holds all 3.
Taking from the opponent applies to every gain source: penalties, replenish, abilities and Royals.
SPENDING: optional action 1 only, at the start of your turn before any replenish. Each scroll spent returns to the supply and gives 1 Gem or Pearl (never Gold) from anywhere on the board. You may spend any number you hold in that one action (Dized FAQ).
Privileges are not tokens and do NOT count toward the 10-token limit. They carry no points.

## replenishRules

From p.4.
- Allowed only when the bag is non-empty.
- Mix the bag. Draw tokens at random and place each on the next EMPTY space in spiral order, starting at the centre (spiral position 1) and skipping occupied spaces, until the bag is empty.
- Then the OPPONENT of the replenishing player takes 1 Privilege, using the acquisition rule: supply, else from the replenisher, else nothing if the opponent already has all 3.
- The board has 25 spaces and the game has 25 tokens, so the bag always fits. Spaces left empty afterwards are the ones latest in the spiral order, among the empty ones.
- The bag contains spent tokens (purchases), end-of-turn discards and nothing else. At setup the bag is empty.
- Forced replenish: see cantAct. It is the same action, so the opponent still gets the Privilege. The rulebook doesn't say this separately, but it tells you to perform the Replenish optional action itself.

## crownsAndRoyals

From p.8 and Dized.
- Some Jewel cards show 1-3 Crowns at the top.
- When you reach your 3rd Crown, take 1 of the available Royal cards and resolve its ability. Do the same when you reach your 6th Crown. That is at most 2 Royals per player (Dized: 2; there is no other way to get one).
- Four Royals exist and each player takes at most 2, so one is always available.
- The trigger is crossing the threshold. Per the card data the max Crowns on one card is 3, so one purchase can cross at most one threshold: from 2 or fewer you cannot reach 6 or more.
- Taking a Royal is not an action (Dized FAQ: No). Keep Royals next to your Jewel cards.
- The 4 Royals: 2 points + steal 1 Gem/Pearl from the opponent; 2 points + extra turn; 2 points + take 1 Privilege; 3 points, no ability.
- Royal cards carry no Crowns and no bonus. Their points count toward 20 total but not toward any colour.
- Each Royal shows both a 3-Crown and a 6-Crown requirement, so any available Royal may be taken at either threshold.
- Crowns come only from Jewel cards, including jokers that have Crowns.
- The Crowns victory (10+) counts all your Crowns.

## endOfTurn

From p.9 and the player aid, after the mandatory action and all abilities and Royals triggered by it:
1) TOKEN LIMIT: count ALL your tokens: Gems + Pearls + Gold. If the total exceeds 10, discard down to exactly 10; you choose which, and they go back to the bag. You may exceed 10 during your turn (Reminders and Dized FAQ). Privileges and reserved cards do not count. The Dized 'Gems and Pearls' page mentions only Gems and Pearls; the rulebook explicitly includes Gold, so follow the rulebook.
2) VICTORY CHECK: check your own victory conditions. If any is met, you win immediately.
3) Otherwise the opponent's turn begins, or your extra turn if one was gained (it starts after this whole end-of-turn procedure).
The royal check sits before the token limit: Royals are taken during the turn when the 3rd or 6th Crown is gained. The player aid order is ability, Royal, 10-token limit, victory.

## victory

Checked at the END of your turn (p.9). If you meet one or more conditions, the game ends immediately and you win:
1) 20 or more Prestige points in total (Jewel cards + Royal cards, including points-only cards).
2) 10 or more Crowns.
3) 10 or more Prestige points on cards of the SAME colour. Jokers count as the colour of the group they sit in. Points-only no-bonus cards and Royal cards count toward no colour (Dized FAQ).
There is no end-of-round equalisation and no tiebreak: the first player to satisfy a condition at the end of their own turn wins. Nothing the active player does can increase the opponent's points or Crowns, so only the active player needs checking. The rulebook gives no other game-end trigger, such as empty decks. Reserved cards give no penalty and no points.

## cantAct

Rulebook p.5, Special case (also on the Dized Game Turn Overview): if you cannot perform ANY of the three mandatory actions, you must perform the Replenish optional action and then choose your mandatory action. As the replenish action, this gives your opponent 1 Privilege.
When no mandatory action is possible:
- no Gem or Pearl on the board, AND
- (no Gold on the board, OR you hold 3 reserved cards, OR no card can be reserved), AND
- you cannot afford any pyramid card or reserved card.
Derived invariant (my own reasoning): both players hold at most 10 tokens at the start of any turn, so at least 5 of the 25 tokens are in the bag or on the board. If the bag were empty, at least 5 tokens would be on the board, and at most 3 of them Gold, so a Gem or Pearl would be available. So at the start of a turn the forced replenish always has a non-empty bag.
The only uncovered corner case: during your turn you spent Privileges (you can then hold more than 10) and/or already replenished, leaving no Gem or Pearl on the board and an empty bag, while you can neither reserve nor buy. The rules are silent here; see uncertainties.

## spiralLayout

Derived from the rulebook art hosted on Dized. dized/take3.jpg shows an empty board with the printed arrows; dized/board.jpg shows the start of the path from the centre as a dotted line: centre, down, left, up. It matches EluvK/splendor-duel-assistant SPIRAL_ORDER exactly and TangChao729's 'center, down first, clockwise' generator.
COORDINATES: (row, col), 0-indexed. Row 0 = the board edge with the 3 privilege-reminder icons (2 Pearls->scroll, replenish->scroll, 3 same->scroll), which faces the Privilege scrolls placed 'above the board'. Col 0 = left.
Placement order 1->25:
1 (2,2) centre
2 (3,2)
3 (3,1)
4 (2,1)
5 (1,1)
6 (1,2)
7 (1,3)
8 (2,3)
9 (3,3)
10 (4,3)
11 (4,2)
12 (4,1)
13 (4,0)
14 (3,0)
15 (2,0)
16 (1,0)
17 (0,0)
18 (0,1)
19 (0,2)
20 (0,3)
21 (0,4)
22 (1,4)
23 (2,4)
24 (3,4)
25 (4,4) end: the dashed end-of-line mark, bottom-right corner.
As a grid of order numbers:
row0: 17 18 19 20 21
row1: 16  5  6  7 22
row2: 15  4  1  8 23
row3: 14  3  2  9 24
row4: 13 12 11 10 25
Movement from the centre: down 1, left 1, up 2, right 2, down 3, left 3, up 4, right 4, down 4. This is clockwise when seen from above with row 0 at the top.
Rotating or mirroring the whole board does not change play, since all line rules are symmetric. The order does matter for which spaces are left empty after a partial replenish.

## faqAndEdgeCases

- Dized FAQ: Pearls can be taken with a Privilege. Gold cannot be taken with a Privilege or with the take-tokens action.
- Dized FAQ: you may use more than one Privilege in a turn. Privileges must be used first; you cannot replenish and then use a Privilege. Using one does not end your turn.
- Dized FAQ: you can take fewer than 3 tokens, even just 1.
- Dized FAQ: max 3 reserved cards. They are secret from the opponent and you can look at your own. A reserved card is played only through the Purchase action. Reserved cards at game end do nothing.
- Dized FAQ: there are 2 Pearls and no Pearl bonus exists on any card.
- Dized FAQ: the token cap is 10. You may hold more during your turn and discard down to 10 at the end. The rulebook counts Gold too.
- Dized FAQ: taking a Royal is not an action. Max 2 Royals per player, gained only at the 3rd and 6th Crowns.
- Dized FAQ: grey cards with no bonus are not their own colour. They don't count for the 10-in-one-colour win but do count toward 20 points.
- Dized FAQ: a joker placed on a card with an ability does NOT trigger that ability.
- Joker points DO count toward the colour it is grouped with (rulebook condition 3 and the Dized example image).
- Joker cannot be purchased without owning a card with a bonus. Reserving it is still allowed.
- Take-tokens lines: 2 tokens must be neighbours (8 directions). 3 tokens must be consecutive in one straight row, column or diagonal. Gold or an empty space breaks the line.
- The 3-same or 2-Pearls penalty applies only to the mandatory take-tokens action. It gives at most 1 Privilege, and it goes to the opponent of the taker, or nothing if the opponent already has all 3.
- Privilege gain with an empty supply: take it from the other player. If you already have all 3, nothing happens. This applies to every source: penalty, replenish, card ability, Royal.
- Replenish requires a non-empty bag. The bag is empty at game start because all 25 tokens start on the board. Replenish always gives the opponent 1 Privilege.
- Reserve needs a Gold token on the board. You cannot reserve without Gold in the base game. The Gold is taken first, then 1 card from the pyramid or the top of any deck.
- An empty deck means the pyramid slot is not refilled. Stated for reserve; apply the same to purchase.
- Spent tokens (including Gold) and discarded tokens go to the bag, never back to the board directly.
- Bonuses can reduce a colour cost to 0 but never below. Pearl costs are never reduced.
- Match-colour ability: take any 1 token of that colour anywhere on the board; ignore it if none. Steal ability: 1 Gem or Pearl from the opponent, never Gold; ignore it if none.
- An extra turn is a complete turn with its own optional actions. Discard and the victory check for the current turn happen before it.
- Card-data fact (unofficial data): no ability card other than jokers carries Crowns. The ability-then-Royal ordering therefore only matters for joker placement, and a single purchase cannot give two extra turns.
- Royal cards: 4 face-up, all available from the start. Effects: 2 points + steal, 2 points + extra turn, 2 points + Privilege, 3 points plain.
- Victory is checked only at the end of the active player's turn, including a turn that is followed by an extra turn.
- Fan-site errors to ignore: splendortactics says the Level-3 deck goes at the bottom (the official rulebook says Level 1 at the bottom). The Dized 'Gems and Pearls' page omits Gold from the 10-token count (the official rulebook includes it).

## uncertainties

- Stacking extra turns: the rulebook doesn't say whether two extra-turn effects in the same turn give two extra turns. Per the card data this cannot happen from one purchase, since no extra-turn card has Crowns. An extra turn gained during an extra turn simply chains. Suggest one pending extra-turn flag per turn.
- No-legal-action corner case: after using Privileges and/or replenishing mid-turn, the board may hold no Gem or Pearl, the bag may be empty, and the player may be unable to reserve (no Gold or 3 reserved) or buy. The rules are silent. Suggested fallback: the player passes to the end-of-turn steps. The forced replenish cannot hit an empty bag at the start of a turn (see the invariant in cantAct).
- Reserve when Gold is on the board but the pyramid and all 3 decks are empty: not addressed. The action requires reserving a card, so treat it as illegal.
- Pyramid refill on purchase from an empty deck: explicitly stated only for reserve; assumed identical.
- Using a Privilege when the board has no Gem or Pearl: not addressed. Implement as disallowed; you may spend at most as many scrolls as there are Gem/Pearl tokens on the board.
- Forced replenish giving the opponent a Privilege: the rule says to perform the Replenish optional action, which includes the Privilege. Assumed yes.
- Order when a joker with Crowns triggers a Royal: the player aid order is ability then Royal. This is only a numbered list, not explicit prose, but it matters little because joker placement doesn't interact with Royals.
- Whether the opponent may see the identity of a card reserved from the face-up pyramid: the rules say reserved cards are kept secret (face down or in hand), even though the card was visible before. A digital version may choose to hide both kinds, per the rules, or reveal pyramid-reserved cards.
- No stated game-end if all decks and the pyramid run out and nobody can win. This is practically unreachable; not covered.
- Per-level card split (30/24/13), the joker, points-only and ability distribution, and the Crown totals come from unofficial card databases. They are consistent with each other and with the card images I checked, but the rulebook does not print them.
- Spiral orientation is given relative to the board edge bearing the privilege-reminder icons, derived from the Dized/rulebook images and confirmed by an independent implementation. Any consistent rotation or mirror plays identically.

## Sources

- https://cdn.1j1ju.com/medias/d5/20/a3-splendor-duel-rulebook.pdf
- https://rules.dized.com/game/W-CkaRFlR36L6fiDQiWcHQ/splendor-duel (+ /faq)
- https://en.doc.boardgamearena.com/Gamehelpsplendorduel
