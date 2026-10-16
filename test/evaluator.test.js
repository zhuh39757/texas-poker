import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../server/evaluator.js';

const ev = (s) => evaluate(s.split(' '));
const beats = (a, b) => assert.ok(ev(a).score > ev(b).score, `${a} 应该大于 ${b}`);
const ties = (a, b) => assert.equal(ev(a).score, ev(b).score, `${a} 应该等于 ${b}`);

test('牌型识别', () => {
  assert.equal(ev('As Ks Qs Js Ts 2d 3c').name, '皇家同花顺');
  assert.equal(ev('9h 8h 7h 6h 5h Ad Ac').name, '同花顺');
  assert.equal(ev('5d 4d 3d 2d Ad Kc Kh').name, '同花顺'); // A-5 同花顺
  assert.equal(ev('7s 7h 7d 7c 2s 3h 9d').name, '四条');
  assert.equal(ev('Ks Kh Kd 2c 2s 9h 4d').name, '葫芦');
  assert.equal(ev('2h 9h Jh 4h 6h Kd Ks').name, '同花');
  assert.equal(ev('5s 6h 7d 8c 9s Kd 2h').name, '顺子');
  assert.equal(ev('As 2h 3d 4c 5s Kd 9h').name, '顺子');
  assert.equal(ev('Qs Qh Qd 2c 5s 9h Kd').name, '三条');
  assert.equal(ev('Js Jh 4d 4c As 9h 2d').name, '两对');
  assert.equal(ev('Ts Th 4d 7c As 9h 2d').name, '一对');
  assert.equal(ev('As Jh 4d 7c 8s 9h 2d').name, '高牌');
});

test('牌型大小顺序', () => {
  beats('As Ks Qs Js Ts', '9h 8h 7h 6h 5h');
  beats('9h 8h 7h 6h 5h', '7s 7h 7d 7c As');
  beats('2s 2h 2d 2c 3s', 'As Ah Ad Kc Ks');
  beats('2s 2h 2d 3c 3s', 'Ah Kh 9h 7h 5h');
  beats('2h 3h 4h 5h 7h', 'Ts Jh Qd Kc As');
  beats('6s 2h 3d 4c 5s', 'As 2h 3d 4c 5s'); // 6 高顺子 > A-5 小顺子
  beats('2s 2h 2d 4c 5s', 'As Ah Kd Kc Qs');
  beats('3s 3h 2d 2c 4s', 'As Ah Kd Qc Js');
  beats('2s 2h 3d 4c 5s', 'As Kh Qd Jc 9s');
});

test('同牌型比踢脚', () => {
  beats('As Ah Kd 9c 8s', 'Ad Ac Qd Jc Ts');
  beats('Ks Kh 7d 7c As', 'Kd Kc 7s 7h Qs');
  beats('Ks Kh 8d 8c 2s', 'Kd Kc 7s 7h As');
  beats('Ah Kh 9h 7h 6h', 'As Ks 9s 7s 5s');
  beats('Js Jh Jd 2c 2s', 'Ts Th Td Ac As');
  ties('As Kh Qd Jc 9s', 'Ad Kc Qh Js 9d');
});

test('7 张牌挑最好的 5 张', () => {
  // 三个对子：取最大的两对 + 最大踢脚
  ties('As Ah Kd Kc Qs Qh 2d', 'Ad Ac Ks Kh Qd 3c 4c');
  // 两个三条组成葫芦，取大的当三条
  assert.equal(ev('9s 9h 9d 5c 5s 5h 2d').name, '葫芦');
  beats('9s 9h 9d 5c 5s 5h 2d', '8s 8h 8d Ac As 3h 2d');
  // 同花里挑最大的 5 张
  beats('Ah 2h 3h 4h 9h Kh Ts', 'Ad 2d 3d 4d 9d Qd Ts');
  // 公共牌就是最大牌：平分
  ties('2c 3d As Ks Qs Js Ts', '4c 5d As Ks Qs Js Ts');
  // 7 连张取最高的顺子
  assert.equal(ev('3s 4h 5d 6c 7s 8h 9d').ranks[0], 9);
});
