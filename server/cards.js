import { randomInt } from 'node:crypto';

// 牌用两个字符表示：点数 + 花色，例如 'As' 'Td' '9h'
export const RANKS = '23456789TJQKA';
export const SUITS = 'shdc'; // 黑桃 红桃 方块 梅花

export function newDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

// Fisher–Yates，用加密级随机数
export function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function rankValue(card) {
  return RANKS.indexOf(card[0]) + 2; // 2..14
}

export function suitOf(card) {
  return card[1];
}
