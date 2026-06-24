/**
 * ArachnoFair (アラクノフェア) コアゲームロジック
 * 
 * このモジュールは、ゲーム状態の管理、プレイヤー行動の処理、
 * 戦闘ロジック、マップ移動、および宝物庫の解錠判定を行います。
 */

// 蜘蛛の巣状マップのノード接続定義 (蜘蛛の巣状トポロジー)
// 0: 中央宝物庫
// 1~12: 外周リング (Outer Ring)
// 13~18: 中周リング (Middle Ring)
// 19~21: 内周リング (Inner Ring)
const MAP_CONNECTIONS = {
  0: [31, 32, 33],
  // 外周リング 4 (1-12)
  1: [2, 12, 13],
  2: [1, 3, 14],
  3: [2, 4, 15],
  4: [3, 5, 16],
  5: [4, 6, 17],
  6: [5, 7, 18],
  7: [6, 8, 19],
  8: [7, 9, 20],
  9: [8, 10, 21],
  10: [9, 11, 22],
  11: [10, 12, 23],
  12: [11, 1, 24],
  // 中外周リング 3 (13-24)
  13: [14, 24, 1, 25],
  14: [13, 15, 2, 25],
  15: [14, 16, 3, 26],
  16: [15, 17, 4, 26],
  17: [16, 18, 5, 27],
  18: [17, 19, 6, 27],
  19: [18, 20, 7, 28],
  20: [19, 21, 8, 28],
  21: [20, 22, 9, 29],
  22: [21, 23, 10, 29],
  23: [22, 24, 11, 30],
  24: [23, 13, 12, 30],
  // 中内周リング 2 (25-30)
  25: [26, 30, 13, 14, 31],
  26: [25, 27, 15, 16, 31],
  27: [26, 28, 17, 18, 32],
  28: [27, 29, 19, 20, 32],
  29: [28, 30, 21, 22, 33],
  30: [29, 25, 23, 24, 33],
  // 内周リング 1 (31-33)
  31: [32, 33, 25, 26, 0],
  32: [31, 33, 27, 28, 0],
  33: [32, 31, 29, 30, 0]
};

// ノードのタイプ定義 (34ノード構成)
const NODE_TYPES = {
  0: 'TREASURY', // 宝物庫 (中心)
  // リング 4 (外周)
  1: 'ITEM', 2: 'EVENT', 3: 'MODIFIER', 4: 'TRAP',
  5: 'ITEM', 6: 'EVENT', 7: 'MODIFIER', 8: 'TRAP',
  9: 'ITEM', 10: 'EVENT', 11: 'MODIFIER', 12: 'TRAP',
  // リング 3 (中外周)
  13: 'ITEM', 14: 'EVENT', 15: 'MODIFIER', 16: 'TRAP',
  17: 'ITEM', 18: 'EVENT', 19: 'MODIFIER', 20: 'TRAP',
  21: 'ITEM', 22: 'EVENT', 23: 'MODIFIER', 24: 'TRAP',
  // リング 2 (中内周)
  25: 'ITEM', 26: 'EVENT', 27: 'MODIFIER', 28: 'TRAP',
  29: 'ITEM', 30: 'EVENT',
  // リング 1 (内周)
  31: 'ITEM', 32: 'EVENT', 33: 'MODIFIER'
};

// 役職（ロール）の定義
const ROLES = {
  adventurer: {
    name: '冒険家',
    desc: '探索特化。移動時に選択できる隣接マスが多く、アイテム発見率が高い。',
    baseMobility: 3, // ダイス最大値
    itemFindRate: 0.8
  },
  engineer: {
    name: 'エンジニア',
    desc: 'アイテム使用に長ける。罠マスのダメージとペナルティを無効化する。',
    baseMobility: 2,
    itemFindRate: 0.5
  },
  treasure_hunter: {
    name: 'トレジャーハンター',
    desc: '戦闘特化。セットコレクション補正が強化され、戦闘時カード初期値にボーナス。',
    baseMobility: 1,
    itemFindRate: 0.5
  },
  tycoon: {
    name: '石油王',
    desc: '資金強奪。他プレイヤーと同じマスに停止した時、相手から金糸またはHPを自動奪取。',
    baseMobility: 2,
    itemFindRate: 0.5
  },
  witch: {
    name: '魔女',
    desc: '呪いと戦闘。他プレイヤーを呪って移動力を1に固定し、バースト上限を低下させる。',
    baseMobility: 3,
    itemFindRate: 0.3
  }
};

/**
 * ゲームステートを初期化する
 */
function createInitialState(playerRole = 'adventurer') {
  // 1〜15の範囲でランダムなベースの目標値 B を決定 (2進法 8-4-2-1 に対応)
  const baseTarget = Math.floor(Math.random() * 15) + 1;

  const roleKeys = Object.keys(ROLES);
  // CPUプレイヤーの役職を重複なしで決定
  const cpuRoles = roleKeys.filter(r => r !== playerRole);
  shuffleArray(cpuRoles);

  // ノードのタイプをランダムにシャッフル (34ノード構成、ノード0は常にTREASURY)
  const typesPool = [
    ...Array(9).fill('ITEM'),
    ...Array(9).fill('EVENT'),
    ...Array(8).fill('MODIFIER'),
    ...Array(7).fill('TRAP')
  ];
  shuffleArray(typesPool);

  const nodeTypes = {
    0: 'TREASURY'
  };
  for (let i = 1; i <= 33; i++) {
    nodeTypes[i] = typesPool[i - 1];
  }

  const players = [
    {
      id: 0,
      name: 'プレイヤー',
      role: playerRole,
      roleName: ROLES[playerRole].name,
      hp: 3000,
      pos: Math.floor(Math.random() * 12) + 1, // 外周のランダムな位置からスタート
      threads: 0, // 所持している蜘蛛の金糸の数
      cards: generateInitialHand(), // 手札カード (戦闘で使用)
      items: [], // 収集アイテム (セットコレクション用)
      hints: [], // 獲得した2進数ヒント
      missCount: 0, // 擬似乱数用のハズレ連続カウント
      mobilityDebuff: false, // 罠マスによる移動力半減
      stickyDebuff: false, // 蜘蛛の巣による移動デバフ
      cursed: false // 魔女の呪い
    },
    {
      id: 1,
      name: 'ライバル A (CPU)',
      role: cpuRoles[0],
      roleName: ROLES[cpuRoles[0]].name,
      hp: 3000,
      pos: Math.floor(Math.random() * 12) + 1,
      threads: 0,
      cards: generateInitialHand(),
      items: [],
      hints: [],
      missCount: 0,
      mobilityDebuff: false,
      stickyDebuff: false,
      cursed: false
    },
    {
      id: 2,
      name: 'ライバル B (CPU)',
      role: cpuRoles[1],
      roleName: ROLES[cpuRoles[1]].name,
      hp: 3000,
      pos: Math.floor(Math.random() * 12) + 1,
      threads: 0,
      cards: generateInitialHand(),
      items: [],
      hints: [],
      missCount: 0,
      mobilityDebuff: false,
      stickyDebuff: false,
      cursed: false
    },
    {
      id: 3,
      name: 'ライバル C (CPU)',
      role: cpuRoles[2],
      roleName: ROLES[cpuRoles[2]].name,
      hp: 3000,
      pos: Math.floor(Math.random() * 12) + 1,
      threads: 0,
      cards: generateInitialHand(),
      items: [],
      hints: [],
      missCount: 0,
      mobilityDebuff: false,
      stickyDebuff: false,
      cursed: false
    },
    {
      id: 4,
      name: 'ライバル D (CPU)',
      role: cpuRoles[3],
      roleName: ROLES[cpuRoles[3]].name,
      hp: 3000,
      pos: Math.floor(Math.random() * 12) + 1,
      threads: 0,
      cards: generateInitialHand(),
      items: [],
      hints: [],
      missCount: 0,
      mobilityDebuff: false,
      stickyDebuff: false,
      cursed: false
    }
  ];

  return {
    players,
    baseTarget, // 2進数判定の基礎値 B
    turn: 0, // 現在のターンプレイヤーID
    turnCount: 1,
    phase: 'ROLL', // ROLL, MOVE, RESOLVE, COMBAT, TREASURY, GAME_OVER
    logs: ['ゲーム「アラクノフェア」が開始されました。目標: 蜘蛛の巣の中央にある宝物庫を目指し、金糸を集めて解錠せよ！'],
    combatState: null, // 戦闘中の情報一時保存用
    treasuryState: null, // 宝物庫挑戦中の一時保存用
    nodeTypes // シャッフルされたノードタイプをゲームステートに保存
  };
}

/**
 * 初期手札 (100〜1000の倍数カード5枚) を生成する
 */
function generateInitialHand() {
  const cards = [];
  for (let i = 0; i < 5; i++) {
    // 100の倍数 (100 ~ 1000)
    cards.push((Math.floor(Math.random() * 10) + 1) * 100);
  }
  return cards.sort((a, b) => a - b);
}

/**
 * 配列をシャッフルするユーティリティ
 */
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * プレイヤーの最終的な解錠目標値 N を算出する
 * N = B (ベース値) + 役職補正 + アイテム補正
 */
function calculateTargetForPlayer(player, baseTarget) {
  let mod = 0;

  // 役職補正: 魔女・石油王は +3
  if (player.role === 'witch' || player.role === 'tycoon') {
    mod += 3;
  }

  // アイテム補正 (セットコレクション): 
  // Ring, Amulet, Crown の3種類が揃っていると -2 (トレジャーハンターは -3)
  const hasRing = player.items.includes('指輪');
  const hasAmulet = player.items.includes('アミュレット');
  const hasCrown = player.items.includes('王冠');

  if (hasRing && hasAmulet && hasCrown) {
    if (player.role === 'treasure_hunter') {
      mod -= 3;
    } else {
      mod -= 2;
    }
  }

  // 1〜15の範囲にクランプする (2進法4ビット 1~15 で表現するため)
  let target = baseTarget + mod;
  if (target < 1) target = 1;
  if (target > 15) target = 15;

  return target;
}

/**
 * 2進数ヒントを生成する
 */
function generateHint(baseTarget, player) {
  const bits = [8, 4, 2, 1];
  // プレイヤーがまだ知らないビットのヒントを選ぶ
  const remainingBits = bits.filter(b => !player.hints.some(h => h.bit === b));

  if (remainingBits.length === 0) {
    return { bit: null, text: 'すべての桁のヒントは既に得られています。' };
  }

  // ランダムに1つ選んで開示
  const chosenBit = remainingBits[Math.floor(Math.random() * remainingBits.length)];
  const isOn = (baseTarget & chosenBit) !== 0;
  const text = `${chosenBit}の位（重み${chosenBit}）は「${isOn ? 'ON (1)' : 'OFF (0)'}」である。`;

  return { bit: chosenBit, text };
}

/**
 * バースト危険度の形容詞表現 (itoスタイル)
 */
function getBurstLevelText(totalSum) {
  if (totalSum <= 800) return '安全';
  if (totalSum <= 1500) return '微熱';
  if (totalSum <= 1900) return '過熱';
  return '臨界点 (バースト寸前)';
}

/**
 * 目標値への遠さの形容詞表現 (ドミニオン/itoスタイルの応用)
 */
function getDistanceText(distance) {
  if (distance >= 8) return '絶望的';
  if (distance >= 5) return 'かなり必要';
  if (distance >= 2) return 'もう少し';
  if (distance === 1) return 'あと一歩';
  return '完全一致';
}

/**
 * ダイスをロールして移動可能数を算出する
 */
function rollDice(player) {
  const roleInfo = ROLES[player.role];
  let maxRoll = roleInfo.baseMobility;

  // 冒険家は移動ダイスが高め
  if (player.role === 'adventurer') {
    maxRoll = 4;
  }

  let roll = Math.floor(Math.random() * maxRoll) + 1;

  // 罠デバフ: 移動力半減 (エンジニア以外)
  if (player.mobilityDebuff && player.role !== 'engineer') {
    roll = Math.max(1, Math.floor(roll / 2));
  }

  // 蜘蛛の巣デバフ: 移動力 -2
  if (player.stickyDebuff) {
    roll = Math.max(1, roll - 2);
  }

  // 魔女の呪い: 移動力を1に固定
  if (player.cursed) {
    roll = 1;
  }

  return roll;
}

/**
 * 指定した距離で到達可能なノードの探索 (BFS)
 * 冒険家は移動フェーズの選択肢が常に1つ多くなるように、最寄りの別ノードも選択肢に含める
 */
function getReachableNodes(startNode, steps, player) {
  let queue = [{ node: startNode, dist: 0 }];
  let visited = {};
  visited[startNode] = true;
  let result = [];

  while (queue.length > 0) {
    const current = queue.shift();

    if (current.dist === steps) {
      if (!result.includes(current.node)) {
        result.push(current.node);
      }
      continue;
    }

    const neighbors = MAP_CONNECTIONS[current.node] || [];
    for (const neighbor of neighbors) {
      if (!visited[neighbor]) {
        visited[neighbor] = true;
        queue.push({ node: neighbor, dist: current.dist + 1 });
      }
    }
  }

  // 目的地が見つからないか、冒険家の特性発動時
  // 冒険家は、移動の自由度を上げるために通常選択肢に隣接ノードをもう1つ追加する
  if (player.role === 'adventurer' || result.length === 0) {
    const directNeighbors = MAP_CONNECTIONS[startNode] || [];
    for (const n of directNeighbors) {
      if (!result.includes(n)) {
        result.push(n);
      }
    }
  }

  return result;
}

/**
 * 擬似乱数ドロー補正付きのイベント抽選
 * 連続してハズレを引いた場合、次回金糸やアイテムが出る確率を上昇させる
 */
function drawEventWithPseudoRandom(player, baseTarget) {
  const baseSuccessProb = 0.4; // 基礎成功確率 40%
  // 役職による確率補正 (冒険家は高く、魔女は低い)
  let roleModifier = 0;
  if (player.role === 'adventurer') roleModifier = 0.2;
  if (player.role === 'witch') roleModifier = -0.1;

  // 連続ハズレ回数(missCount)に応じて、確率を20%ずつ上乗せする (確率の罠対策)
  const currentProb = baseSuccessProb + roleModifier + (player.missCount * 0.2);

  const isSuccess = Math.random() < currentProb;

  if (isSuccess) {
    player.missCount = 0; // 成功したためカウンターをリセット
    // 蜘蛛の金糸を獲得するか、ヒントを獲得するか
    if (Math.random() < 0.5) {
      player.threads += 1;
      return {
        type: 'thread',
        text: `${player.name}は蜘蛛の金糸を1本獲得しました！ (所持金糸: ${player.threads})`
      };
    } else {
      const hint = generateHint(baseTarget, player);
      if (hint.bit !== null) {
        player.hints.push(hint);
      }
      return {
        type: 'hint',
        text: `${player.name}は解錠のヒントを入手しました！`
      };
    }
  } else {
    player.missCount += 1; // ハズレ回数をカウントアップ
    return {
      type: 'miss',
      text: `${player.name}はエリアを探索しましたが、有益なものは見つかりませんでした。(探索確率補正が上昇しました)`
    };
  }
}

/**
 * アイテムマスでアイテムを抽選する (擬似乱数補正付き)
 */
function drawItemWithPseudoRandom(player) {
  const possibleItems = ['指輪', 'アミュレット', '王冠'];
  const baseSuccessProb = 0.5;
  const roleModifier = player.role === 'adventurer' ? 0.25 : 0;
  const currentProb = baseSuccessProb + roleModifier + (player.missCount * 0.15);

  const isSuccess = Math.random() < currentProb;

  if (isSuccess) {
    player.missCount = 0;
    // まだ持っていないアイテムを優先的に選ぶ
    const remainingItems = possibleItems.filter(item => !player.items.includes(item));
    const chosenItem = remainingItems.length > 0 
      ? remainingItems[Math.floor(Math.random() * remainingItems.length)]
      : possibleItems[Math.floor(Math.random() * possibleItems.length)];

    player.items.push(chosenItem);
    // 戦闘力を上げるため、手札も1枚補充
    player.cards.push((Math.floor(Math.random() * 10) + 1) * 100);
    player.cards.sort((a, b) => a - b);

    // エンジニアの特性: アイテム獲得時に追加でもう1枚引ける
    if (player.role === 'engineer' && player.items.length < 5) {
      const extraItem = possibleItems[Math.floor(Math.random() * possibleItems.length)];
      player.items.push(extraItem);
      return {
        type: 'item',
        text: `${player.name}はアイテム「${chosenItem}」を獲得しました！ さらにエンジニアの能力で「${extraItem}」も入手！`
      };
    }

    return {
      type: 'item',
      text: `${player.name}はアイテム「${chosenItem}」を獲得し、手札カードを1枚補充しました！`
    };
  } else {
    player.missCount += 1;
    // 最低限、戦闘用カードを1枚配る
    player.cards.push((Math.floor(Math.random() * 6) + 1) * 100);
    player.cards.sort((a, b) => a - b);
    return {
      type: 'miss',
      text: `${player.name}は目ぼしい装備は見つかりませんでした。代わりに戦闘カードを1枚補充しました。`
    };
  }
}

/**
 * CPUの意思決定ロジック (戦闘時のカードプレイ)
 */
function makeCpuCombatDecision(cpuPlayer, currentSum, oppSum, round) {
  const limit = 2000;
  if (!cpuPlayer.cards || cpuPlayer.cards.length === 0) {
    return 0; // 手札切れのためスキップ
  }
  // 手札からバーストしない安全なカードを選択する
  const safeCards = cpuPlayer.cards.filter(c => currentSum + c < limit);

  // もし安全なカードがないなら、バースト回避のためスキップ（パス）を選択
  if (safeCards.length === 0) {
    return 0;
  }

  // トレジャーハンターまたは魔女なら、少しリスクをとって高い数値を狙う
  const isAggressive = cpuPlayer.role === 'treasure_hunter' || cpuPlayer.role === 'witch';
  
  if (isAggressive) {
    // 限界に近い(過熱状態)を目指して、最大の安全カードを出す
    return safeCards[safeCards.length - 1];
  }

  // 通常のAIは、現在の相手の数値と比較して超えられる最小のカードを出すか、中間のカードを出す
  const targetToBeat = oppSum - currentSum;
  const cardsToWin = safeCards.filter(c => c > targetToBeat);

  if (cardsToWin.length > 0) {
    return cardsToWin[0]; // 相手を上回る最小のカード
  }

  // 勝てそうにない場合は、低めのカードを温存せずに消費する (5本のきゅうり風の温存)
  return safeCards[0];
}

/**
 * CPUの移動先決定ロジック
 */
function makeCpuMoveDecision(cpuPlayer, reachableNodes, players, baseTarget, nodeTypes) {
  // 宝物庫 (0) が選択肢にあれば、金糸をたくさん持っていれば最優先で向かう
  if (reachableNodes.includes(0) && cpuPlayer.threads >= 2) {
    return 0;
  }

  // 金糸が足りない、または宝物庫に入れない場合は、イベントマスやアイテムマスを優先する
  const eventNodes = reachableNodes.filter(n => nodeTypes[n] === 'EVENT');
  const itemNodes = reachableNodes.filter(n => nodeTypes[n] === 'ITEM');
  
  // 石油王なら、他のプレイヤーがいるマスに積極的に入り込む
  if (cpuPlayer.role === 'tycoon') {
    for (const n of reachableNodes) {
      const hasOpponent = players.some(p => p.id !== cpuPlayer.id && p.pos === n);
      if (hasOpponent) {
        return n; // 強奪のために突撃
      }
    }
  }

  if (eventNodes.length > 0) {
    return eventNodes[Math.floor(Math.random() * eventNodes.length)];
  }

  if (itemNodes.length > 0) {
    return itemNodes[Math.floor(Math.random() * itemNodes.length)];
  }

  // それ以外はランダムに移動
  return reachableNodes[Math.floor(Math.random() * reachableNodes.length)];
}

module.exports = {
  MAP_CONNECTIONS,
  NODE_TYPES,
  ROLES,
  createInitialState,
  calculateTargetForPlayer,
  generateInitialHand,
  generateHint,
  getBurstLevelText,
  getDistanceText,
  rollDice,
  getReachableNodes,
  drawEventWithPseudoRandom,
  drawItemWithPseudoRandom,
  makeCpuCombatDecision,
  makeCpuMoveDecision
};
