const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const game = require('./gameLogic');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ゲームルーム状態管理
// rooms[roomId] = { id: roomId, players: [ { socketId, id, name, role } ], gameState: { ... } }
const rooms = {};

// カスタムルーム待機状態管理
const customRooms = {};

// マッチング待機キュー
let waitingQueue = [];
let matchingTimer = null;
const MATCH_TIMEOUT = 10; // 秒

/**
 * ログを追加するユーティリティ
 */
function addLog(gameState, message) {
  gameState.logs.push(`[ターン${gameState.turnCount}] ${message}`);
  if (gameState.logs.length > 50) {
    gameState.logs.shift();
  }
}

/**
 * 他のプレイヤーとルーム全員にステートをブロードキャストする
 */
function broadcastState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit('game:state', room.gameState);
}

/**
 * マッチングキューの更新をブロードキャスト
 */
function broadcastQueueUpdate() {
  io.emit('queue:update', {
    count: waitingQueue.length,
    players: waitingQueue.map(p => ({ name: p.name, role: p.role, ready: !!p.ready }))
  });
}

/**
 * オートマッチング開始 (準備完了ボタン仕様のため廃止・互換用に残す)
 */
function startMatchingTimer() {
  // 準備完了ボタンで開始するため、タイマー自動開始は行わない
}

/**
 * 待機キュー内の全員が準備OKであればゲームを開始する
 */
function checkAndStartGame() {
  if (waitingQueue.length === 0) return;
  const allReady = waitingQueue.every(p => p.ready);
  if (allReady) {
    console.log('全員の準備が完了しました。ゲームを開始します。');
    createNewRoom();
  }
}

/**
 * カスタムルームのプレイヤーから新ルームを作成してゲーム開始 (最大5人)
 */
function startCustomGame(roomName) {
  const room = customRooms[roomName];
  if (!room || room.length === 0) return;

  const roomId = 'room_' + Math.random().toString(36).substr(2, 9);
  const matchedPlayers = room.slice(0, Math.min(5, room.length)); // 最大5人
  
  // 5人初期状態を作成
  const baseRole = matchedPlayers[0].role;
  const gameState = game.createInitialState(baseRole);

  const roomPlayers = [];
  const assignedRoles = matchedPlayers.map(p => p.role);

  // 人間プレイヤーの割り当て
  matchedPlayers.forEach((p, idx) => {
    const playerObj = gameState.players[idx];
    playerObj.name = p.name;
    playerObj.role = p.role;
    playerObj.roleName = game.ROLES[p.role].name;
    playerObj.isCpu = false;
    playerObj.socketId = p.socketId;

    roomPlayers.push({
      socketId: p.socketId,
      id: idx,
      name: p.name,
      role: p.role
    });
  });

  // 不足分をCPUとして割り当て (5人構成)
  const cpuRolesPool = Object.keys(game.ROLES).filter(r => !assignedRoles.includes(r));
  for (let idx = matchedPlayers.length; idx < 5; idx++) {
    const cpuRole = cpuRolesPool[idx - matchedPlayers.length] || 'adventurer';
    const cpuObj = gameState.players[idx];
    cpuObj.name = `ライバル ${String.fromCharCode(65 + (idx - matchedPlayers.length))} (CPU)`;
    cpuObj.role = cpuRole;
    cpuObj.roleName = game.ROLES[cpuRole].name;
    cpuObj.isCpu = true;
    cpuObj.socketId = null;
  }

  // 初期化完了ログ
  gameState.logs = [`カスタムルーム「${roomName}」での対戦が開始されました！`];
  addLog(gameState, `参加プレイヤー: ${matchedPlayers.map(p => `${p.name}(${game.ROLES[p.role].name})`).join(', ')}`);

  rooms[roomId] = {
    id: roomId,
    players: roomPlayers,
    gameState
  };

  // 各Socketへマッチング完了とアサインIDを通達
  matchedPlayers.forEach((p, idx) => {
    io.to(p.socketId).emit('match:success', {
      roomId,
      playerId: idx
    });
  });

  // 新しいラウンドを開始
  startNewRound(gameState);

  // カスタムルームを消去
  delete customRooms[roomName];
}

/**
 * キューにいるプレイヤーから新ルームを作成してゲーム開始 (最大5人)
 */
function createNewRoom() {
  const roomId = 'room_' + Math.random().toString(36).substr(2, 9);
  const matchedPlayers = waitingQueue.splice(0, Math.min(5, waitingQueue.length)); // 最大5人
  
  // 5人初期状態を作成
  const baseRole = matchedPlayers[0].role;
  const gameState = game.createInitialState(baseRole);

  const roomPlayers = [];
  const assignedRoles = matchedPlayers.map(p => p.role);

  // 人間プレイヤーの割り当て
  matchedPlayers.forEach((p, idx) => {
    const playerObj = gameState.players[idx];
    playerObj.name = p.name;
    playerObj.role = p.role;
    playerObj.roleName = game.ROLES[p.role].name;
    playerObj.isCpu = false;
    playerObj.socketId = p.socketId;

    roomPlayers.push({
      socketId: p.socketId,
      id: idx,
      name: p.name,
      role: p.role
    });
  });

  // 不足分をCPUとして割り当て (5人構成)
  const cpuRolesPool = Object.keys(game.ROLES).filter(r => !assignedRoles.includes(r));
  for (let idx = matchedPlayers.length; idx < 5; idx++) {
    const cpuRole = cpuRolesPool[idx - matchedPlayers.length] || 'adventurer';
    const cpuObj = gameState.players[idx];
    cpuObj.name = `ライバル ${String.fromCharCode(65 + (idx - matchedPlayers.length))} (CPU)`;
    cpuObj.role = cpuRole;
    cpuObj.roleName = game.ROLES[cpuRole].name;
    cpuObj.isCpu = true;
    cpuObj.socketId = null;
  }

  // 初期化完了ログ
  gameState.logs = ['オンライン対戦ゲームが開始されました！蜘蛛の巣の宝物庫を目指し、金糸を集めましょう。'];
  addLog(gameState, `参加プレイヤー: ${matchedPlayers.map(p => `${p.name}(${game.ROLES[p.role].name})`).join(', ')}`);

  rooms[roomId] = {
    id: roomId,
    players: roomPlayers,
    gameState
  };

  // 各Socketへマッチング完了とアサインIDを通達
  matchedPlayers.forEach((p, idx) => {
    io.to(p.socketId).emit('match:success', {
      roomId,
      playerId: idx
    });
  });

  // 新しいラウンドを開始
  startNewRound(gameState);

  broadcastQueueUpdate();
}

/**
 * 新しいラウンドの開始 (全員同時ロール開始)
 */
function startNewRound(gameState) {
  gameState.phase = 'ROLL';
  gameState.rolled = {};
  gameState.moved = {};
  gameState.reachableNodes = {};

  // CPU全員のダイスを自動ロールして記録
  gameState.players.forEach(p => {
    if (p.hp <= 0) {
      // HPがない場合は行動不能
      gameState.rolled[p.id] = 0;
      gameState.moved[p.id] = p.pos;
      return;
    }
    if (p.isCpu) {
      const roll = game.rollDice(p);
      gameState.rolled[p.id] = roll;
    }
  });

  addLog(gameState, `--- ラウンド ${gameState.turnCount} 開始 --- 全員ダイスをロールしてください。`);
}

/**
 * 移動したマスのイベント効果を解決する
 */
function resolveNodeLanding(gameState, player, node) {
  const nodeType = gameState.nodeTypes[node];

  if (node === 0) {
    // 宝物庫（中央）に到着
    const reqThreads = game.getRequiredThreadsForPlayer(player, gameState.baseTarget);

    if (player.threads < reqThreads) {
      // 蜘蛛の金糸が不足している場合、ランダムなマス（1〜33）に弾き飛ばされる
      const randomNode = Math.floor(Math.random() * 33) + 1;
      player.pos = randomNode;
      player.hp = Math.max(0, player.hp - 300); // 結界による衝撃ダメージ
      addLog(gameState, `【警告】${player.name}は宝物庫に進入しましたが、金糸数（${player.threads}本）が必要数（${reqThreads}本）に満たないため、防衛結界によりHP-300のダメージを受け、マス ${randomNode} に弾き飛ばされました！`);
      
      if (player.hp <= 0) {
        player.hp = 3000;
        player.pos = Math.floor(Math.random() * 12) + 1;
        addLog(gameState, `${player.name}のHPが0になりました。スタート地点に戻ります。`);
      }
      
      gameState.phase = 'RESOLVE';
      return;
    }

    gameState.phase = 'TREASURY';
    addLog(gameState, `${player.name}が中央の宝物庫に到着しました！解錠を試みることができます。`);
    return;
  }

  if (nodeType === 'TRAP') {
    if (player.role === 'engineer') {
      addLog(gameState, `エンジニアの特性により、${player.name}は罠マスのダメージとペナルティを無効化しました！`);
    } else {
      player.hp = Math.max(0, player.hp - 500);
      player.mobilityDebuff = true;
      addLog(gameState, `罠が発動！ ${player.name}は 500 HPのダメージを受け、次ターンの移動力が半減します！ (残りHP: ${player.hp})`);
      if (player.hp <= 0) {
        addLog(gameState, `${player.name}のHPが0になりました。スタート地点に戻ります。`);
        player.hp = 3000;
        player.pos = Math.floor(Math.random() * 12) + 1;
      }
    }
  } else if (nodeType === 'ITEM') {
    const res = game.drawItemWithPseudoRandom(player);
    addLog(gameState, res.text);
  } else if (nodeType === 'EVENT') {
    const res = game.drawEventWithPseudoRandom(player, gameState.baseTarget);
    addLog(gameState, res.text);
  } else if (nodeType === 'MODIFIER') {
    if (Math.random() < 0.5) {
      player.stickyDebuff = true;
      addLog(gameState, `蜘蛛の巣に絡まりました！ ${player.name}は次ターンの移動力が-2されます。`);
    } else {
      const windDestinations = {
        // リング 4 -> リング 3 (1-12 -> 13-24)
        1: 13, 2: 14, 3: 15, 4: 16, 5: 17, 6: 18, 
        7: 19, 8: 20, 9: 21, 10: 22, 11: 23, 12: 24,
        // リング 3 -> リング 2 (13-24 -> 25-30)
        13: 25, 14: 25, 15: 26, 16: 26, 17: 27, 18: 27,
        19: 28, 20: 28, 21: 29, 22: 29, 23: 30, 24: 30,
        // リング 2 -> リング 1 (25-30 -> 31-33)
        25: 31, 26: 31, 27: 32, 28: 32, 29: 33, 30: 33,
        // リング 1 -> 宝物庫 (31-33 -> 0)
        31: 0, 32: 0, 33: 0
      };
      const windNode = windDestinations[node] !== undefined ? windDestinations[node] : 0;
      player.pos = windNode;
      addLog(gameState, `強風が吹きました！ ${player.name}は風に流され、内側のマス ${windNode} へ移動させられました。`);
      if (windNode === 0) {
        resolveNodeLanding(gameState, player, 0);
        return;
      }
    }
  }

  if (gameState.phase !== 'TREASURY' && gameState.phase !== 'GAME_OVER') {
    gameState.phase = 'RESOLVE';
  }
}

/**
 * 全プレイヤーの移動と解決を一括で実行する (全員同時ターン制用)
 */
function executeAllPlayersMoveAndResolve(gameState, roomId) {
  addLog(gameState, `【システム】全員の移動先が確定しました。一斉移動を開始します。`);

  // 1. 位置の更新とデバフのクリア、および移動カード獲得
  gameState.players.forEach(p => {
    if (p.hp <= 0) return;
    const dest = gameState.moved[p.id];
    p.pos = dest;

    p.mobilityDebuff = false;
    p.stickyDebuff = false;
    p.cursed = false;

    // 移動時にランダムな数のカードを1枚必ず取得
    const newCard = (Math.floor(Math.random() * 10) + 1) * 100;
    p.cards.push(newCard);
    p.cards.sort((a, b) => a - b);
    addLog(gameState, `【移動ボーナス】${p.name}は移動により戦闘カード（値: ${newCard}）を1枚獲得しました。`);
  });

  // 2. 各プレイヤーの着地イベント解決
  gameState.players.forEach(p => {
    if (p.hp <= 0) return;
    resolveNodeLanding(gameState, p, p.pos);
  });

  // 3. 特殊スキルの発動 (石油王、魔女)
  gameState.players.forEach(p => {
    if (p.hp <= 0) return;
    
    const opponents = gameState.players.filter(o => o.id !== p.id && o.pos === p.pos && o.hp > 0);
    if (opponents.length > 0) {
      if (p.role === 'tycoon') {
        opponents.forEach(o => {
          if (o.threads > 0) {
            o.threads -= 1;
            p.threads += 1;
            addLog(gameState, `石油王の特権発動！ ${p.name}は同じマスの ${o.name} から金糸を1本奪いました！`);
          } else {
            o.hp = Math.max(0, o.hp - 300);
            addLog(gameState, `石油王の特権発動！ ${p.name}は同じマスの ${o.name} のHPを300奪いました！`);
          }
        });
      }
      if (p.role === 'witch') {
        opponents.forEach(o => {
          o.cursed = true;
          addLog(gameState, `魔女の呪い発動！ ${o.name}は呪いにかかり、次ターンの移動力が1に固定されます！`);
        });
      }
    }
  });

  // 4. 戦闘の判定と解決
  const combatPairs = [];
  const checked = new Set();

  gameState.players.forEach(p => {
    if (p.hp <= 0 || p.pos === 0) return; // 宝物庫のマスでは戦闘は起きない
    if (checked.has(p.id)) return;

    const opponents = gameState.players.filter(o => o.id !== p.id && o.pos === p.pos && o.hp > 0);
    if (opponents.length > 0) {
      const opponent = opponents[0];
      combatPairs.push({ attacker: p.id, defender: opponent.id });
      checked.add(p.id);
      checked.add(opponent.id);
    }
  });

  if (combatPairs.length > 0) {
    gameState.pendingCombats = combatPairs.slice(1);
    startCombat(gameState, combatPairs[0].attacker, combatPairs[0].defender, roomId);
  } else {
    // 戦闘がない場合、宝物庫のチェックへ
    checkTreasuryEntry(gameState, roomId);
  }
}

/**
 * 戦闘を開始する
 */
function startCombat(gameState, attackerId, defenderId, roomId, isTreasuryCombat = false) {
  const attacker = gameState.players[attackerId];
  const defender = gameState.players[defenderId];

  gameState.phase = 'COMBAT';
  gameState.combatState = {
    attacker: attackerId,
    defender: defenderId,
    attackerSum: 0,
    defenderSum: 0,
    attackerCardPlayed: null,
    defenderCardPlayed: null,
    plays: {},
    round: 1,
    isTreasuryCombat: isTreasuryCombat
  };

  addLog(gameState, `【戦闘発生】マス ${attacker.pos} にて、${attacker.name} と ${defender.name} の戦闘が始まりました！`);
  triggerCpuCombatDecision(gameState);
  resolveCombatRound(gameState, roomId);
}

/**
 * CPUが戦闘カードを決定してコミットする
 */
function triggerCpuCombatDecision(gameState) {
  const cState = gameState.combatState;
  if (!cState) return;

  const attacker = gameState.players[cState.attacker];
  const defender = gameState.players[cState.defender];

  if (attacker.isCpu && cState.plays[cState.attacker] === undefined) {
    const card = game.makeCpuCombatDecision(attacker, cState.attackerSum, cState.defenderSum, cState.round);
    if (card > 0) {
      attacker.cards.splice(attacker.cards.indexOf(card), 1);
    }
    cState.plays[cState.attacker] = card;
  }

  if (defender.isCpu && cState.plays[cState.defender] === undefined) {
    const card = game.makeCpuCombatDecision(defender, cState.defenderSum, cState.attackerSum, cState.round);
    if (card > 0) {
      defender.cards.splice(defender.cards.indexOf(card), 1);
    }
    cState.plays[cState.defender] = card;
  }
}

/**
 * 宝物庫の進入チェック
 */
function checkTreasuryEntry(gameState, roomId) {
  const candidates = [];
  gameState.players.forEach(p => {
    if (p.pos === 0 && p.hp > 0) {
      const reqThreads = game.getRequiredThreadsForPlayer(p, gameState.baseTarget);

      if (p.threads >= reqThreads) {
        candidates.push(p.id);
      }
    }
  });

  if (candidates.length > 0) {
    if (candidates.length > 1) {
      // 宝物庫の到達が同じターンに複数人（解錠可能プレイヤー）だった場合、戦闘に入る
      const p1Id = candidates[0];
      const p2Id = candidates[1];
      addLog(gameState, `【宝物庫争奪戦】複数のプレイヤーが同時に宝物庫に到達しました！解錠権をかけて戦闘を開始します。`);
      startCombat(gameState, p1Id, p2Id, roomId, true); // isTreasuryCombat = true
      return;
    }

    gameState.phase = 'TREASURY';
    const firstId = candidates[0];
    gameState.turn = firstId;
    gameState.pendingTreasury = candidates.slice(1);
    
    const firstPlayer = gameState.players[firstId];
    if (firstPlayer.isCpu) {
      attemptCpuUnlock(gameState, firstPlayer);
      if (gameState.phase !== 'GAME_OVER') {
        handlePostTreasury(gameState, roomId);
      }
    } else {
      addLog(gameState, `${firstPlayer.name}が宝物庫の解錠シーケンスを開始します！`);
    }
  } else {
    // 誰も入らない場合は、ターンカウントを上げて次のラウンドへ
    gameState.turnCount += 1;
    startNewRound(gameState);
  }
}

/**
 * 戦闘終了後の遷移処理
 */
function handlePostCombat(gameState, roomId) {
  gameState.combatState = null;

  if (gameState.pendingCombats && gameState.pendingCombats.length > 0) {
    const next = gameState.pendingCombats.shift();
    startCombat(gameState, next.attacker, next.defender, roomId);
  } else {
    // すべての戦闘が終了したため、宝物庫のチェックへ
    checkTreasuryEntry(gameState, roomId);
  }
}

/**
 * 宝物庫挑戦後の遷移処理
 */
function handlePostTreasury(gameState, roomId) {
  if (gameState.pendingTreasury && gameState.pendingTreasury.length > 0) {
    const nextId = gameState.pendingTreasury.shift();
    gameState.turn = nextId;
    const nextPlayer = gameState.players[nextId];
    
    if (nextPlayer.isCpu) {
      attemptCpuUnlock(gameState, nextPlayer);
      if (gameState.phase !== 'GAME_OVER') {
        handlePostTreasury(gameState, roomId);
      }
    } else {
      addLog(gameState, `${nextPlayer.name}が宝物庫の解錠シーケンスを開始します！`);
    }
  } else {
    // 挑戦者がいなくなった場合、次のラウンドへ
    gameState.turnCount += 1;
    startNewRound(gameState);
  }
}

/**
 * 戦闘ラウンドの解決 (両者のコミット確認)
 */
function resolveCombatRound(gameState, roomId) {
  const cState = gameState.combatState;
  if (!cState) return;

  if (cState.plays[cState.attacker] !== undefined && cState.plays[cState.defender] !== undefined) {
    const attackerCard = cState.plays[cState.attacker];
    const defenderCard = cState.plays[cState.defender];

    const attacker = gameState.players[cState.attacker];
    const defender = gameState.players[cState.defender];

    cState.attackerCardPlayed = attackerCard;
    cState.defenderCardPlayed = defenderCard;
    cState.attackerSum += attackerCard;
    cState.defenderSum += defenderCard;

    addLog(gameState, `ラウンド${cState.round}戦闘結果: ${attacker.name}は [${attackerCard}] を公開、${defender.name}は [${defenderCard}] を公開！`);

    let attackerLimit = 2000;
    if (attacker.role === 'witch') attackerLimit = 2500;
    else if (attacker.role === 'tycoon') attackerLimit = 1800;

    let defenderLimit = 2000;
    if (defender.role === 'witch') defenderLimit = 2500;
    else if (defender.role === 'tycoon') defenderLimit = 1800;

    const attackerBurst = cState.attackerSum > attackerLimit;
    const defenderBurst = cState.defenderSum > defenderLimit;

    if (cState.round >= 3 || attackerBurst || defenderBurst) {
      // 戦闘終了解決
      resolvePlayerCombatResult(gameState, attacker, defender, cState.attackerSum, cState.defenderSum, attackerBurst, defenderBurst);
      
      if (gameState.phase !== 'COMBAT_REWARD') {
        handlePostCombat(gameState, roomId);
      }
    } else {
      // ラウンド進行
      cState.round += 1;
      cState.plays = {}; // プレイ履歴の初期化
      
      // 次のラウンドでもし相手（または自分）がCPUなら自動決定を走らせる
      triggerCpuCombatDecision(gameState);
      
      // CPU同士やCPU即答などにより、カードがすでに揃っている場合は再帰解決
      resolveCombatRound(gameState, roomId);
    }
  }
}


/**
 * 戦闘チェック
 */
function checkForCombat(roomId, movingPlayer) {
  const room = rooms[roomId];
  const gameState = room.gameState;

  const opponent = gameState.players.find(p => p.id !== movingPlayer.id && p.pos === movingPlayer.pos);
  if (!opponent) return;

  // 石油王強奪
  if (movingPlayer.role === 'tycoon') {
    if (opponent.threads > 0) {
      opponent.threads -= 1;
      movingPlayer.threads += 1;
      addLog(gameState, `石油王の特権発動！ ${movingPlayer.name}は ${opponent.name} から金糸を1本強奪しました！`);
    } else {
      opponent.hp = Math.max(0, opponent.hp - 300);
      addLog(gameState, `石油王の特権発動！ ${movingPlayer.name}は金糸を持たない ${opponent.name} のHPを300奪いました！`);
    }
  }

  // 魔女呪い
  if (movingPlayer.role === 'witch') {
    opponent.cursed = true;
    addLog(gameState, `魔女の呪い発動！ ${opponent.name}は呪いにかかり、次ターンの移動力が1に固定されます！`);
  }

  // 戦闘状態のセットアップ
  gameState.phase = 'COMBAT';
  gameState.combatState = {
    attacker: movingPlayer.id,
    defender: opponent.id,
    attackerSum: 0,
    defenderSum: 0,
    attackerCardPlayed: null,
    defenderCardPlayed: null,
    plays: {}, // 人間プレイヤー同士のプレイカード記録用
    round: 1
  };
  addLog(gameState, `${movingPlayer.name}が ${opponent.name} と接触しました！戦闘開始！`);
}

/**
 * 戦闘勝利時のデフォルト報酬
 */
function transferCombatReward(gameState, winner, loser) {
  if (loser.threads > 0) {
    loser.threads -= 1;
    winner.threads += 1;
    addLog(gameState, `戦闘勝利！ ${winner.name} は ${loser.name} から蜘蛛の金糸を1本強奪しました！`);
  } else {
    loser.hp = Math.max(0, loser.hp - 300);
    winner.hp = Math.min(3000, winner.hp + 200);
    addLog(gameState, `戦闘勝利！ ${winner.name} は金糸を持たない ${loser.name} に打撃を与え、HPを奪いました！`);
  }
}

/**
 * 戦闘結果の解決
 */
function resolvePlayerCombatResult(gameState, p1, p2, p1Sum, p2Sum, p1Burst, p2Burst) {
  addLog(gameState, `戦闘集計: ${p1.name} 合計値 [${p1Sum}] ${p1Burst ? '(臨界点突破)' : ''} vs ${p2.name} 合計値 [${p2Sum}] ${p2Burst ? '(臨界点突破)' : ''}`);

  const isTreasuryCombat = gameState.combatState && gameState.combatState.isTreasuryCombat;

  if (isTreasuryCombat) {
    let winner = null;
    let loser = null;
    let isDraw = false;

    if (p1Burst && p2Burst) {
      isDraw = true;
      p1.hp = Math.max(0, p1.hp - 500);
      p2.hp = Math.max(0, p2.hp - 500);
      addLog(gameState, `両者バーストにより自滅！ お互いに 500 HPのダメージを受けました。`);
    } else if (p1Burst) {
      winner = p2;
      loser = p1;
      p1.hp = Math.max(0, p1.hp - 500);
      addLog(gameState, `${p1.name}がバースト自滅！`);
    } else if (p2Burst) {
      winner = p1;
      loser = p2;
      p2.hp = Math.max(0, p2.hp - 500);
      addLog(gameState, `${p2.name}がバースト自滅！`);
    } else {
      if (p1Sum > p2Sum) {
        winner = p1;
        loser = p2;
      } else if (p2Sum > p1Sum) {
        winner = p2;
        loser = p1;
      } else {
        isDraw = true;
        addLog(gameState, `戦闘は引き分けとなりました。`);
      }
    }

    if (isDraw) {
      // 引き分けの場合、両プレイヤーとも解錠できずランダムなマップに転移させます
      const p1RandomNode = Math.floor(Math.random() * 33) + 1;
      const p2RandomNode = Math.floor(Math.random() * 33) + 1;
      p1.pos = p1RandomNode;
      p2.pos = p2RandomNode;
      addLog(gameState, `引き分けのため、両プレイヤーとも宝物庫を解錠できず、${p1.name}はマス ${p1RandomNode}、${p2.name}はマス ${p2RandomNode} に転移させられました。`);
    } else {
      // 勝ったプレイヤーが宝物庫の解錠できるようにし、負けたプレイヤーはランダムなマップに転移させます
      const loserRandomNode = Math.floor(Math.random() * 33) + 1;
      loser.pos = loserRandomNode;
      addLog(gameState, `戦闘勝利！ ${winner.name} が宝物庫の解錠権を獲得しました！ 敗れた ${loser.name} はマス ${loserRandomNode} に転移させられました。`);
    }

    // 敗者のスタート戻り判定 (HPが0になった場合)
    [p1, p2].forEach(p => {
      if (p.hp <= 0) {
        p.hp = 3000;
        p.pos = Math.floor(Math.random() * 12) + 1;
        addLog(gameState, `${p.name}は力尽き、スタート地点に戻されました。`);
      }
    });

    gameState.phase = 'RESOLVE';
    gameState.combatState = null;
    return;
  }

  if (p1Burst && p2Burst) {
    p1.hp = Math.max(0, p1.hp - 500);
    p2.hp = Math.max(0, p2.hp - 500);
    addLog(gameState, `両者バーストにより自滅！ お互いに 500 HPのダメージを受けました。`);
    gameState.phase = 'RESOLVE';
    gameState.combatState = null;
  } else if (p1Burst) {
    p1.hp = Math.max(0, p1.hp - 500);
    addLog(gameState, `${p1.name}がバースト自滅！`);
    if (p2.isCpu) {
      transferCombatReward(gameState, p2, p1);
      gameState.phase = 'RESOLVE';
      gameState.combatState = null;
    } else {
      gameState.phase = 'COMBAT_REWARD';
      gameState.combatState.winner = p2.id;
      gameState.combatState.loser = p1.id;
    }
  } else if (p2Burst) {
    p2.hp = Math.max(0, p2.hp - 500);
    addLog(gameState, `${p2.name}がバースト自滅！`);
    if (p1.isCpu) {
      transferCombatReward(gameState, p1, p2);
      gameState.phase = 'RESOLVE';
      gameState.combatState = null;
    } else {
      gameState.phase = 'COMBAT_REWARD';
      gameState.combatState.winner = p1.id;
      gameState.combatState.loser = p2.id;
    }
  } else {
    // 両者バーストしなかった場合、合計値が大きい方の勝ち
    if (p1Sum > p2Sum) {
      if (p1.isCpu) {
        transferCombatReward(gameState, p1, p2);
        gameState.phase = 'RESOLVE';
        gameState.combatState = null;
      } else {
        gameState.phase = 'COMBAT_REWARD';
        gameState.combatState.winner = p1.id;
        gameState.combatState.loser = p2.id;
      }
    } else if (p2Sum > p1Sum) {
      if (p2.isCpu) {
        transferCombatReward(gameState, p2, p1);
        gameState.phase = 'RESOLVE';
        gameState.combatState = null;
      } else {
        gameState.phase = 'COMBAT_REWARD';
        gameState.combatState.winner = p2.id;
        gameState.combatState.loser = p1.id;
      }
    } else {
      addLog(gameState, `戦闘は引き分けとなりました。`);
      gameState.phase = 'RESOLVE';
      gameState.combatState = null;
    }
  }

  // 敗者のスタート戻り判定
  [p1, p2].forEach(p => {
    if (p.hp <= 0) {
      p.hp = 3000;
      p.pos = Math.floor(Math.random() * 12) + 1;
      addLog(gameState, `${p.name}は力尽き、スタート地点に戻されました。`);
    }
  });
}

/**
 * 報酬選択の解決
 */
function resolveRewardChoice(gameState, winner, loser, choice) {
  if (choice === 'loot') {
    if (loser.items.length > 0) {
      const idx = Math.floor(Math.random() * loser.items.length);
      const lootedItem = loser.items.splice(idx, 1)[0];
      winner.items.push(lootedItem);
      addLog(gameState, `【略奪】${winner.name} は ${loser.name} から「${lootedItem}」を略奪しました！`);
      
      if (winner.role === 'treasure_hunter') {
        winner.cards.push((Math.floor(Math.random() * 8) + 3) * 100);
        winner.cards.sort((a, b) => a - b);
        addLog(gameState, `トレジャーハンター補正！ ${winner.name} は戦闘カードを1枚補充しました。`);
      }
    } else {
      transferCombatReward(gameState, winner, loser);
    }
  } else if (choice === 'destroy') {
    if (loser.cards.length > 0) {
      loser.cards.sort((a, b) => a - b);
      const discarded = [];
      for (let i = 0; i < 2; i++) {
        if (loser.cards.length > 0) {
          discarded.push(loser.cards.pop());
        }
      }
      addLog(gameState, `【手札破壊】${winner.name} は ${loser.name} の手札から [${discarded.join(', ')}] を破壊しました！`);
    } else {
      transferCombatReward(gameState, winner, loser);
    }
  } else if (choice === 'thread') {
    if (loser.threads > 0) {
      loser.threads -= 1;
      winner.threads += 1;
      addLog(gameState, `【金糸強奪】${winner.name} は ${loser.name} から蜘蛛の金糸を1本強奪しました！`);
    } else {
      loser.hp = Math.max(0, loser.hp - 300);
      winner.hp = Math.min(3000, winner.hp + 200);
      addLog(gameState, `【金糸強奪】${winner.name} は金糸を持たない ${loser.name} に打撃を与え、HPを奪いました！`);
    }
  }
}

/**
 * CPU同士の戦闘解決
 */
function resolveCpuVsCpuCombat(gameState, cpu1, cpu2) {
  // 自動簡略判定: ランダムに勝敗を決定
  const winner = Math.random() < 0.5 ? cpu1 : cpu2;
  const loser = winner.id === cpu1.id ? cpu2 : cpu1;

  if (loser.threads > 0) {
    loser.threads -= 1;
    winner.threads += 1;
    addLog(gameState, `【戦闘】${winner.name} が ${loser.name} との戦闘に勝利し、金糸を1本強奪しました。`);
  } else {
    loser.hp = Math.max(0, loser.hp - 300);
    addLog(gameState, `【戦闘】${winner.name} が ${loser.name} との戦闘に勝利し、打撃を与えました。`);
    if (loser.hp <= 0) {
      loser.hp = 3000;
      loser.pos = Math.floor(Math.random() * 12) + 1;
      addLog(gameState, `${loser.name}はリタイアし、スタート地点に戻されました。`);
    }
  }
}

/**
 * CPUが戦闘を仕掛けたかのチェック
 */
function checkCpuCombatTrigger(roomId, cpu) {
  const room = rooms[roomId];
  const gameState = room.gameState;
  const opponent = gameState.players.find(p => p.id !== cpu.id && p.pos === cpu.pos);
  if (!opponent) return false;

  // 石油王
  if (cpu.role === 'tycoon') {
    if (opponent.threads > 0) {
      opponent.threads -= 1;
      cpu.threads += 1;
      addLog(gameState, `石油王の特権！ ${cpu.name}が ${opponent.name} から金糸を1本奪いました！`);
    } else {
      opponent.hp = Math.max(0, opponent.hp - 300);
      addLog(gameState, `石油王の特権！ ${cpu.name}が ${opponent.name} のHPを300奪いました！`);
    }
  }

  // 魔女
  if (cpu.role === 'witch') {
    opponent.cursed = true;
    addLog(gameState, `魔女の呪い！ ${opponent.name}は移動力を縛られました。`);
  }

  // プレイヤー（人間）が戦闘に関わる場合
  if (!cpu.isCpu || !opponent.isCpu) {
    gameState.phase = 'COMBAT';
    gameState.combatState = {
      attacker: cpu.id,
      defender: opponent.id,
      attackerSum: 0,
      defenderSum: 0,
      attackerCardPlayed: null,
      defenderCardPlayed: null,
      plays: {},
      round: 1
    };
    addLog(gameState, `${cpu.name}が ${opponent.name} に戦闘を仕掛けました！`);
    return true;
  } else {
    // CPU同士の戦闘は即時解決
    resolveCpuVsCpuCombat(gameState, cpu, opponent);
    return false;
  }
}

/**
 * CPUが宝物庫の解錠に挑戦する
 */
function attemptCpuUnlock(gameState, cpu) {
  const targetN = game.calculateTargetForPlayer(cpu, gameState.baseTarget);
  
  let activeBits = 0;
  let tempN = targetN;
  const slotsToActivate = { '8': 0, '4': 0, '2': 0, '1': 0 };
  const weights = [8, 4, 2, 1];
  weights.forEach(w => {
    const qty = Math.floor(tempN / w);
    if (qty > 0) {
      slotsToActivate[w.toString()] = qty;
      activeBits += qty;
      tempN -= w * qty;
    }
  });

  if (cpu.role === 'tycoon') {
    activeBits = 9;
  }

  if (cpu.threads >= activeBits) {
    // 消費して解錠
    cpu.threads = Math.max(0, cpu.threads - activeBits);
    gameState.phase = 'GAME_OVER';
    gameState.winner = cpu.id;
    const activeDesc = Object.keys(slotsToActivate)
      .filter(k => slotsToActivate[k] > 0)
      .map(k => `${k}x${slotsToActivate[k]}`)
      .join(', ');
    addLog(gameState, `【ゲームオーバー】${cpu.name}は目標値 ${targetN} に合わせて金糸をスロット[${activeDesc}]に投入し、見事に宝物庫を解錠しました！`);
  } else {
    const randomNode = Math.floor(Math.random() * 3) + 31; // 内周に弾かれる
    cpu.pos = randomNode;
    cpu.hp = Math.max(0, cpu.hp - 600);
    addLog(gameState, `${cpu.name}は宝物庫に進入しましたが、金糸数（${cpu.threads}本）が必要数（${activeBits}本）に満たないため、防衛システムによりダメージを受け、マス ${randomNode} に弾き飛ばされました。`);
    if (cpu.hp <= 0) {
      cpu.hp = 3000;
      cpu.pos = Math.floor(Math.random() * 12) + 1;
      addLog(gameState, `${cpu.name}は力尽きました。スタート地点に戻ります。`);
    }
  }
}

/**
 * CPUプレイヤー達のターン処理
 */
function runCpuTurns(roomId) {
  const room = rooms[roomId];
  const gameState = room.gameState;

  // 戦闘一時停止などから再開した場合は、戦闘を処理したCPUの次のCPUからスタートする
  let startIdx = 0;
  if (gameState.turn >= 0 && gameState.turn <= 4) {
    startIdx = gameState.turn + 1;
  }

  for (let i = startIdx; i <= 4; i++) {
    if (gameState.phase === 'GAME_OVER') break;

    gameState.turn = i;
    const cpu = gameState.players[i];

    // 人間の場合は自動処理を止めてループを終了 (人間の手番を待つ)
    if (!cpu.isCpu) {
      break;
    }

    // HPがない場合はスキップして回復
    if (cpu.hp <= 0) {
      cpu.hp = 1500;
      addLog(gameState, `${cpu.name}は回復のためこのターン行動をパスしました。`);
      continue;
    }

    cpu.mobilityDebuff = false;
    cpu.stickyDebuff = false;
    cpu.cursed = false;

    // 1. ダイスロール
    const roll = game.rollDice(cpu);
    
    // 2. 移動先算出
    const reachable = game.getReachableNodes(cpu.pos, roll, cpu);

    // 3. 移動決定
    const targetNode = game.makeCpuMoveDecision(cpu, reachable, gameState.players, gameState.baseTarget, gameState.nodeTypes);
    cpu.pos = targetNode;
    addLog(gameState, `${cpu.name}(${cpu.roleName})が移動しました: マス ${targetNode} (出目: ${roll})`);

    // 4. マスの効果解決
    if (targetNode === 0) {
      attemptCpuUnlock(gameState, cpu);
    } else {
      resolveNodeLanding(gameState, cpu, targetNode);
      const combatTriggered = checkCpuCombatTrigger(roomId, cpu);
      if (combatTriggered) {
        break; // 戦闘が発生したため、ターン処理を一時停止
      }
    }
  }
}

/**
 * CPUのターンを順番に実行し、終わったらフェーズを人間のダイスロールに戻す
 */
function runCpuTurnsAndProgress(roomId) {
  const room = rooms[roomId];
  const gameState = room.gameState;

  runCpuTurns(roomId);

  // 全員の行動が完了しており、戦闘などで停止していなければ、手番を次の人(または0)に戻してROLLフェーズへ
  if (gameState.phase !== 'GAME_OVER' && gameState.phase !== 'COMBAT' && gameState.phase !== 'COMBAT_REWARD') {
    // 手番が 4 に到達した、または次の人が人間プレイヤーである場合
    let nextTurn = (gameState.turn + 1) % 5;
    gameState.turn = nextTurn;
    
    // もし次の手番がCPUなら (通常は起こらないが、ループ再確認)
    if (gameState.players[nextTurn].isCpu) {
      runCpuTurnsAndProgress(roomId);
    } else {
      gameState.phase = 'ROLL';
      gameState.turnCount += 1;
      const nextPlayer = gameState.players[nextTurn];
      addLog(gameState, `${nextPlayer.name}のターンになります。ダイスを振ってください。`);
    }
  }
}

// -------------------------------------------------------------
// Socket.io 通信ハンドラ
// -------------------------------------------------------------
io.on('connection', (socket) => {
  console.log(`クライアント接続: ${socket.id}`);

  // 1.1 カスタムルームへのジョイン
  socket.on('custom-room:join', async ({ roomName, playerName, role }) => {
    // 既存のオートマッチングキューや他のカスタムルームから離脱
    waitingQueue = waitingQueue.filter(p => p.socketId !== socket.id);
    broadcastQueueUpdate();
    
    // 他のカスタムルームから退出
    for (const rName in customRooms) {
      customRooms[rName] = customRooms[rName].filter(p => p.socketId !== socket.id);
      io.to('lobby_' + rName).emit('custom-room:update', {
        roomName: rName,
        players: customRooms[rName].map(p => ({ name: p.name, role: p.role, ready: p.ready }))
      });
      if (customRooms[rName].length === 0) {
        delete customRooms[rName];
      }
    }

    if (!customRooms[roomName]) {
      customRooms[roomName] = [];
    }

    if (customRooms[roomName].length >= 5) {
      socket.emit('custom-room:error', { message: 'ルームが満員です (最大5人)' });
      return;
    }

    customRooms[roomName].push({
      socketId: socket.id,
      name: playerName || '無名エージェント',
      role: role || 'adventurer',
      ready: false
    });

    await socket.join('lobby_' + roomName);
    console.log(`カスタムルーム [${roomName}] に参加: ${playerName} (${role})`);
    
    io.to('lobby_' + roomName).emit('custom-room:update', {
      roomName,
      players: customRooms[roomName].map(p => ({ name: p.name, role: p.role, ready: p.ready }))
    });
  });

  // 1.2 カスタムルームの準備状態変更
  socket.on('custom-room:ready', ({ roomName, ready }) => {
    const room = customRooms[roomName];
    if (!room) return;

    const player = room.find(p => p.socketId === socket.id);
    if (player) {
      player.ready = !!ready;
      console.log(`カスタムルーム [${roomName}] 準備状態変更: ${player.name} -> ${player.ready ? 'READY' : 'NOT READY'}`);
      
      io.to('lobby_' + roomName).emit('custom-room:update', {
        roomName,
        players: room.map(p => ({ name: p.name, role: p.role, ready: p.ready }))
      });
    }
  });

  // 1.25 カスタムルーム対戦開始 (ホスト/プレイヤーによる開始ボタン押下)
  socket.on('custom-room:start-match', ({ roomName }) => {
    const room = customRooms[roomName];
    if (room && room.length >= 1 && room.every(p => p.ready)) {
      console.log(`カスタムルーム [${roomName}] の対戦を手動開始します。`);
      startCustomGame(roomName);
    }
  });

  // 1.3 カスタムルームからの離脱
  socket.on('custom-room:leave', async ({ roomName }) => {
    if (customRooms[roomName]) {
      customRooms[roomName] = customRooms[roomName].filter(p => p.socketId !== socket.id);
      await socket.leave('lobby_' + roomName);
      console.log(`カスタムルーム [${roomName}] から退出: Socket ${socket.id}`);

      io.to('lobby_' + roomName).emit('custom-room:update', {
        roomName,
        players: customRooms[roomName].map(p => ({ name: p.name, role: p.role, ready: p.ready }))
      });

      if (customRooms[roomName].length === 0) {
        delete customRooms[roomName];
      }
    }
  });

  // 1. オートマッチングキューに参加
  socket.on('queue:join', ({ playerName, role }) => {
    // 既存の接続があれば一度削除
    waitingQueue = waitingQueue.filter(p => p.socketId !== socket.id);

    // 他のカスタムルームから退出（二重待機防止）
    for (const rName in customRooms) {
      customRooms[rName] = customRooms[rName].filter(p => p.socketId !== socket.id);
      io.to('lobby_' + rName).emit('custom-room:update', {
        roomName: rName,
        players: customRooms[rName].map(p => ({ name: p.name, role: p.role, ready: p.ready }))
      });
      if (customRooms[rName].length === 0) {
        delete customRooms[rName];
      }
    }

    waitingQueue.push({
      socketId: socket.id,
      name: playerName || '無名エージェント',
      role: role || 'adventurer',
      ready: false // 初期値は未準備
    });

    console.log(`キュー追加: ${playerName} (${role}) - キュー人数: ${waitingQueue.length}`);
    broadcastQueueUpdate();
  });

  // 1.5 準備完了状態の切り替え
  socket.on('queue:ready', ({ ready }) => {
    const player = waitingQueue.find(p => p.socketId === socket.id);
    if (player) {
      player.ready = !!ready;
      console.log(`準備状態変更: ${player.name} -> ${player.ready ? 'READY' : 'NOT READY'}`);
      broadcastQueueUpdate();
    } else {
      console.log(`[デバッグ警告] queue:ready を受信しましたが、ソケットID ${socket.id} が待機キューに見つかりません。現在のキュー:`, waitingQueue.map(p => p.socketId));
    }
  });

  // 1.6 オートマッチング対戦開始 (プレイヤーによる開始ボタン押下)
  socket.on('queue:start-match', () => {
    const player = waitingQueue.find(p => p.socketId === socket.id);
    if (player && waitingQueue.length >= 2 && waitingQueue.every(p => p.ready)) {
      console.log('オートマッチング対戦を手動開始します。');
      createNewRoom();
    }
  });

  // 2. オートマッチングキューから退出
  socket.on('queue:leave', () => {
    waitingQueue = waitingQueue.filter(p => p.socketId !== socket.id);
    console.log(`キュー退出 - キュー人数: ${waitingQueue.length}`);
    broadcastQueueUpdate();
  });

  // 3. 待機キューに1人以上いる場合に即時開始 (シングルプレイ用の後方互換対応)
  socket.on('queue:start-immediate', () => {
    const playerInQueue = waitingQueue.find(p => p.socketId === socket.id);
    if (playerInQueue) {
      playerInQueue.ready = true;
      console.log(`即時開始/自動準備完了: ${playerInQueue.name}`);
      broadcastQueueUpdate();
      // 即時開始時は、チェックなしで直接ルームを作成する
      createNewRoom();
    }
  });

  // 4. ゲームルームへのジョイン
  socket.on('game:join', ({ roomId }) => {
    const room = rooms[roomId];
    if (room) {
      socket.join(roomId);
      console.log(`Socket ${socket.id} がルーム ${roomId} に入室しました。`);
      // 初回状態を送信
      socket.emit('game:state', room.gameState);
    }
  });

  // 5. ゲームのアクション処理 (各プレイヤーからのアクション)
  socket.on('game:action', ({ roomId, action, data }) => {
    const room = rooms[roomId];
    if (!room) return;

    const gameState = room.gameState;
    const pIdx = gameState.players.findIndex(p => p.socketId === socket.id);
    if (pIdx === -1) return;

    const player = gameState.players[pIdx];
    const isMyTurn = (gameState.turn === pIdx);
    const cState = gameState.combatState;
    const isCombatParticipant = cState && 
      (cState.attacker === pIdx || cState.defender === pIdx);

    // デバッグ表示
    console.log(`アクション受信 [${action}] from ${socket.id} (PlayerID: ${pIdx}) in room ${roomId}. isMyTurn: ${isMyTurn}`);

    // --- A. ダイスロールアクション ---
    if (action === 'roll') {
      if (gameState.phase !== 'ROLL') return;
      if (player.hp <= 0) return;
      if (gameState.rolled[pIdx] !== undefined) return;

      const roll = game.rollDice(player);
      gameState.rolled[pIdx] = roll;
      
      const reachable = game.getReachableNodes(player.pos, roll, player);
      gameState.reachableNodes[pIdx] = reachable;

      addLog(gameState, `${player.name}(${player.roleName})がダイスを振り「${roll}」が出ました。`);

      // 生きているプレイヤー全員がロールを完了したか確認
      const activePlayers = gameState.players.filter(p => p.hp > 0);
      const allRolled = activePlayers.every(p => gameState.rolled[p.id] !== undefined);

      if (allRolled) {
        gameState.phase = 'MOVE';
        
        // CPUの移動先を決定して記録
        gameState.players.forEach(p => {
          if (p.isCpu && p.hp > 0) {
            const cpuRoll = gameState.rolled[p.id];
            const cpuReachable = game.getReachableNodes(p.pos, cpuRoll, p);
            const cpuDest = game.makeCpuMoveDecision(p, cpuReachable, gameState.players, gameState.baseTarget, gameState.nodeTypes);
            gameState.moved[p.id] = cpuDest;
          }
        });
        
        addLog(gameState, `【システム】全員がダイスを振りました。移動先を選択してください。`);
      }

      broadcastState(roomId);
    }

    // --- B. 移動アクション ---
    else if (action === 'move') {
      if (gameState.phase !== 'MOVE') return;
      if (player.hp <= 0) return;
      if (gameState.moved[pIdx] !== undefined) return;

      const targetNode = parseInt(data.targetNode);
      const myReachable = gameState.reachableNodes[pIdx] || [];
      if (!myReachable.includes(targetNode)) return;

      gameState.moved[pIdx] = targetNode;
      addLog(gameState, `${player.name}が移動先をマス ${targetNode} に決定しました。`);

      // 生きているプレイヤー全員が移動先を決定したか確認
      const activePlayers = gameState.players.filter(p => p.hp > 0);
      const allMoved = activePlayers.every(p => gameState.moved[p.id] !== undefined);

      if (allMoved) {
        executeAllPlayersMoveAndResolve(gameState, roomId);
      }

      broadcastState(roomId);
    }

    // --- D. 戦闘カードプレイアクション ---
    else if (action === 'combat:play' && isCombatParticipant) {
      if (gameState.phase !== 'COMBAT' || !cState) return;

      const cardValue = parseInt(data.cardValue);

      if (cardValue > 0) {
        // 手札にあるかチェックして消費
        const cardIndex = player.cards.indexOf(cardValue);
        if (cardIndex === -1) return;
        player.cards.splice(cardIndex, 1);

        // コミットされたプレイカードを一時保存
        cState.plays[pIdx] = cardValue;
        addLog(gameState, `${player.name}はカードを1枚裏向きでセットしました。`);
      } else {
        // カードを出さずにスキップ
        cState.plays[pIdx] = 0;
        addLog(gameState, `${player.name}はカードを出さずにスキップしました。`);
      }

      // 対戦相手がCPUの場合、即座にCPUのカードを自動決定してコミットする
      const opponentId = (pIdx === cState.attacker) ? cState.defender : cState.attacker;
      const opponent = gameState.players[opponentId];

      if (opponent.isCpu && cState.plays[opponentId] === undefined) {
        const cpuSum = (opponentId === cState.attacker) ? cState.attackerSum : cState.defenderSum;
        const playerSum = (pIdx === cState.attacker) ? cState.attackerSum : cState.defenderSum;
        const cpuCard = game.makeCpuCombatDecision(opponent, cpuSum, playerSum, cState.round);
        
        if (cpuCard > 0) {
          const cpuCardIndex = opponent.cards.indexOf(cpuCard);
          if (cpuCardIndex !== -1) {
            opponent.cards.splice(cpuCardIndex, 1);
          }
        }
        cState.plays[opponentId] = cpuCard;
      }

      // 両者のカードが出揃った場合、解決する
      resolveCombatRound(gameState, roomId);
      broadcastState(roomId);
    }

    // --- E. 戦闘からの逃走アクション ---
    else if (action === 'combat:flee' && isCombatParticipant) {
      if (gameState.phase !== 'COMBAT' || !cState) return;

      // HPペナルティ
      player.hp = Math.max(0, player.hp - 300);
      
      // 隣接マスへ緊急離脱 (外周1〜12のランダムなマス)
      const escapeNode = Math.floor(Math.random() * 12) + 1;
      player.pos = escapeNode;

      addLog(gameState, `${player.name}は戦闘から逃走し、HP-300のペナルティを受けマス ${escapeNode} へ離脱しました。`);

      if (player.hp <= 0) {
        player.hp = 3000;
        player.pos = Math.floor(Math.random() * 12) + 1;
        addLog(gameState, `${player.name}のHPが0になりました。スタート地点に戻ります。`);
      }

      handlePostCombat(gameState, roomId);
      broadcastState(roomId);
    }

    // --- F. 戦闘勝利の報酬請求アクション ---
    else if (action === 'reward:claim' && cState && cState.winner === pIdx) {
      if (gameState.phase !== 'COMBAT_REWARD') return;

      const choice = data.choice; // 'loot' or 'destroy'
      const winner = gameState.players[cState.winner];
      const loser = gameState.players[cState.loser];

      resolveRewardChoice(gameState, winner, loser, choice);

      handlePostCombat(gameState, roomId);
      broadcastState(roomId);
    }

    // --- G. 宝物庫の解錠試行アクション ---
    else if (action === 'treasury:unlock' && isMyTurn) {
      if (gameState.phase !== 'TREASURY') return;

      const slots = data.slots; // { '8': boolean, '4': boolean, '2': boolean, '1': boolean }
      const targetN = game.calculateTargetForPlayer(player, gameState.baseTarget);

      // アクティブなスロットの合計を算出 (複数個の投入に対応)
      let sum = 0;
      let activeCount = 0;
      const weights = ['8', '4', '2', '1'];
      weights.forEach(w => {
        const count = parseInt(slots[w] || 0);
        sum += parseInt(w) * count;
        activeCount += count;
      });

      if (player.role === 'tycoon') {
        activeCount = 9;
      }

      if (player.threads < activeCount) return; // 金糸不足

      // 金糸の消費
      player.threads = Math.max(0, player.threads - activeCount);

      if (sum === targetN) {
        // 解錠成功！ゲームオーバー
        gameState.phase = 'GAME_OVER';
        gameState.winner = player.id;
        addLog(gameState, `【ミッション成功】${player.name}は自身の解錠目標値 N = [${targetN}] (${sum}) を金糸の投入により完全一致させ、宝物庫の解錠に成功しました！`);
      } else {
        // 失敗時のペナルティ
        const penaltyNodes = [31, 32, 33];
        const randomNode = penaltyNodes[Math.floor(Math.random() * penaltyNodes.length)];
        player.pos = randomNode;
        player.hp = Math.max(0, player.hp - 600);

        addLog(gameState, `【警告】${player.name}の投入合計値（${sum}）は目標値（${targetN}）と一致しませんでした。セキュリティ反発によりHP-600のダメージを受け、内周のマス ${randomNode} に弾き飛ばされました！`);

        if (player.hp <= 0) {
          player.hp = 3000;
          player.pos = Math.floor(Math.random() * 12) + 1;
          addLog(gameState, `${player.name}のHPが0になりました。スタート地点に戻ります。`);
        }

        handlePostTreasury(gameState, roomId);
      }

      broadcastState(roomId);
    }

    // --- H. 宝物庫からの引き返しアクション ---
    else if (action === 'treasury:cancel' && isMyTurn) {
      if (gameState.phase !== 'TREASURY') return;

      handlePostTreasury(gameState, roomId);
      broadcastState(roomId);
    }
  });

  // 6. 切断時の処理
  socket.on('disconnect', () => {
    console.log(`クライアント切断: ${socket.id}`);
    
    // マッチング待機キューから削除
    waitingQueue = waitingQueue.filter(p => p.socketId !== socket.id);
    broadcastQueueUpdate();

    // カスタムルームから削除
    for (const rName in customRooms) {
      const originalLength = customRooms[rName].length;
      customRooms[rName] = customRooms[rName].filter(p => p.socketId !== socket.id);
      if (customRooms[rName].length !== originalLength) {
        io.to('lobby_' + rName).emit('custom-room:update', {
          roomName: rName,
          players: customRooms[rName].map(p => ({ name: p.name, role: p.role, ready: p.ready }))
        });
        if (customRooms[rName].length === 0) {
          delete customRooms[rName];
        }
      }
    }

    // 進行中のゲームルームからの切断対応 (人間プレイヤーが抜けた場合、CPU化してゲームを自動進行させる)
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const playerIdx = room.gameState.players.findIndex(p => p.socketId === socket.id);
      if (playerIdx !== -1) {
        const playerObj = room.gameState.players[playerIdx];
        playerObj.name += ' (切断/CPU化)';
        playerObj.isCpu = true; // CPUに置き換えてゲームを継続可能にする
        playerObj.socketId = null;
        
        addLog(room.gameState, `接続切れにより、${playerObj.name} はAI管理に移行しました。`);
        
        // 現在のゲーム状況に応じて、AIとしての即時行動をトリガー
        if (room.gameState.phase === 'ROLL' && room.gameState.rolled[playerIdx] === undefined) {
          const roll = game.rollDice(playerObj);
          room.gameState.rolled[playerIdx] = roll;
          room.gameState.reachableNodes[playerIdx] = game.getReachableNodes(playerObj.pos, roll, playerObj);
          
          const activePlayers = room.gameState.players.filter(p => p.hp > 0);
          const allRolled = activePlayers.every(p => room.gameState.rolled[p.id] !== undefined);
          if (allRolled) {
            room.gameState.phase = 'MOVE';
            room.gameState.players.forEach(p => {
              if (p.isCpu && p.hp > 0) {
                const cpuRoll = room.gameState.rolled[p.id];
                const cpuReachable = game.getReachableNodes(p.pos, cpuRoll, p);
                const cpuDest = game.makeCpuMoveDecision(p, cpuReachable, room.gameState.players, room.gameState.baseTarget, room.gameState.nodeTypes);
                room.gameState.moved[p.id] = cpuDest;
              }
            });
            addLog(room.gameState, `【システム】全員がダイスを振りました。移動先を選択してください。`);
          }
        }
        else if (room.gameState.phase === 'MOVE' && room.gameState.moved[playerIdx] === undefined) {
          const cpuRoll = room.gameState.rolled[playerIdx];
          const cpuReachable = room.gameState.reachableNodes[playerIdx] || [];
          const cpuDest = game.makeCpuMoveDecision(playerObj, cpuReachable, room.gameState.players, room.gameState.baseTarget, room.gameState.nodeTypes);
          room.gameState.moved[playerIdx] = cpuDest;
          
          const activePlayers = room.gameState.players.filter(p => p.hp > 0);
          const allMoved = activePlayers.every(p => room.gameState.moved[p.id] !== undefined);
          if (allMoved) {
            executeAllPlayersMoveAndResolve(room.gameState, roomId);
          }
        }
        else if (room.gameState.phase === 'COMBAT' && room.gameState.combatState) {
          const cState = room.gameState.combatState;
          if (cState.plays[playerIdx] === undefined) {
            triggerCpuCombatDecision(room.gameState);
            resolveCombatRound(room.gameState, roomId);
          }
        }
        else if (room.gameState.phase === 'TREASURY' && room.gameState.turn === playerIdx) {
          attemptCpuUnlock(room.gameState, playerObj);
          if (room.gameState.phase !== 'GAME_OVER') {
            handlePostTreasury(room.gameState, roomId);
          }
        }
        
        broadcastState(roomId);
      }
    }
  });
});

// HTTP REST API 互換用ダミーエンドポイント (ポーリングや初期画面用)
app.get('/api/state', (req, res) => {
  // 後方互換性のためにモックステートを返す
  res.json({ phase: 'LOBBY', message: 'Socket.io接続を使用してください' });
});

// フロントエンドの静的ファイルをサーブ
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// SPA対応（どのルートへのアクセスでもフロントエンドの index.html を返す）
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

server.listen(PORT, () => {
  console.log(`ArachnoFair backend server is running on http://localhost:${PORT}`);
});
