/**
 * ArachnoFair (アラクノフェア) フロントエンド・コントロール・スクリプト
 * 
 * Socket.io を使用してリアルタイムのオンラインマルチプレイ、
 * オートマッチング、およびシングルプレイ (自動CPU補完) を同期管理し、
 * SVGマップの描画、プレイヤーステータス、テキストログなどを動的に更新します。
 */

// Socket.io クライアントインスタンス
let socket = null;
let myRoomId = null;
let myPlayerId = null; // ルーム内でのプレイヤーインデックス (0〜4)
let isReady = false;

// ゲームのローカルステート
let state = null;

// 宝物庫の解錠用スロットに入力された金糸数
let treasurySlots = { '8': 0, '4': 0, '2': 0, '1': 0 };

// 役職選択状態
let selectedRole = 'adventurer';

// マスの物理座標マッピング (SVG中心を 0, 0 としたときの座標)
const nodePositions = {};

// ズーム値
let zoomLevel = 1.0;

// 同心円の各リング半径 (34ノード4層構成)
const R_INNER = 55;        // リング 1 (31-33)
const R_MID_INNER = 110;   // リング 2 (25-30)
const R_MID_OUTER = 165;   // リング 3 (13-24)
const R_OUTER = 220;       // リング 4 (1-12)

/**
 * 角度(度数法)からラジアンに変換する
 */
function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * SVGのviewBoxプロパティを更新してズーム効果を実現する
 */
function updateMapViewBox() {
  const baseWidth = 500;
  const baseHeight = 500;
  const w = baseWidth / zoomLevel;
  const h = baseHeight / zoomLevel;
  const x = -w / 2;
  const y = -h / 2;
  const svg = document.getElementById('spider-map');
  if (svg) {
    svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  }
}

/**
 * マスの座標を極座標系で算出する (34ノード対応)
 */
function calculateNodePositions() {
  // 宝物庫 (中心)
  nodePositions[0] = { x: 0, y: 0 };

  // 内周リング 1 (31-33): 3ノード (90度, 210度, 330度)
  const ring1Angles = [90, 210, 330];
  ring1Angles.forEach((angle, idx) => {
    const rad = degToRad(angle);
    nodePositions[31 + idx] = {
      x: Math.round(R_INNER * Math.cos(rad)),
      y: Math.round(-R_INNER * Math.sin(rad))
    };
  });

  // 中内周リング 2 (25-30): 6ノード (30度, 90度, 150度, 210度, 270度, 330度)
  const ring2Angles = [30, 90, 150, 210, 270, 330];
  ring2Angles.forEach((angle, idx) => {
    const rad = degToRad(angle);
    nodePositions[25 + idx] = {
      x: Math.round(R_MID_INNER * Math.cos(rad)),
      y: Math.round(-R_MID_INNER * Math.sin(rad))
    };
  });

  // 中外周リング 3 (13-24): 12ノード (0度, 30度, 60度, 90度, ..., 330度)
  for (let i = 0; i < 12; i++) {
    const angle = i * 30;
    const rad = degToRad(angle);
    nodePositions[13 + i] = {
      x: Math.round(R_MID_OUTER * Math.cos(rad)),
      y: Math.round(-R_MID_OUTER * Math.sin(rad))
    };
  }

  // 外周リング 4 (1-12): 12ノード (0度, 30度, 60度, 90度, ..., 330度)
  for (let i = 0; i < 12; i++) {
    const angle = i * 30;
    const rad = degToRad(angle);
    nodePositions[1 + i] = {
      x: Math.round(R_OUTER * Math.cos(rad)),
      y: Math.round(-R_OUTER * Math.sin(rad))
    };
  }
}

/**
 * ドキュメント読み込み時の初期化
 */
document.addEventListener('DOMContentLoaded', () => {
  calculateNodePositions();
  setupSocket();
  setupEventListeners();
});

/**
 * Socket.io の接続とイベント登録
 */
function setupSocket() {
  // グローバル io() で接続
  socket = io();

  socket.on('connect', () => {
    console.log('対戦ネットワークに接続されました:', socket.id);
  });

  // 待機キューの更新
  socket.on('queue:update', ({ count, players }) => {
    document.getElementById('matching-count').textContent = count;
    const listEl = document.getElementById('matching-player-list');
    listEl.innerHTML = '';

    if (players.length === 0) {
      listEl.innerHTML = '<span style="color: var(--text-muted);">スキャン中...</span>';
    } else {
      players.forEach(p => {
        const item = document.createElement('div');
        item.style.padding = '6px 0';
        item.style.borderBottom = '1px solid rgba(255,255,255,0.02)';
        item.style.display = 'flex';
        item.style.justifyContent = 'space-between';
        item.style.alignItems = 'center';

        const readyBadge = p.ready 
          ? `<span class="safety-badge safety-safe" style="font-size: 0.65rem; padding: 1px 4px; margin-top: 0;">READY</span>`
          : `<span class="safety-badge safety-warm" style="font-size: 0.65rem; padding: 1px 4px; margin-top: 0;">準備中</span>`;

        item.innerHTML = `
          <div>
            <span class="text-cyan">> ${escapeHTML(p.name)}</span> 
            <span style="font-size: 0.75rem; color: var(--text-muted);">(${getNodeRoleNameJa(p.role)})</span>
          </div>
          ${readyBadge}
        `;
        listEl.appendChild(item);
      });
    }
  });

  // マッチング成立
  socket.on('match:success', ({ roomId, playerId }) => {
    console.log(`マッチング成立！ RoomID: ${roomId}, PlayerID: ${playerId}`);
    myRoomId = roomId;
    myPlayerId = playerId;

    // 準備完了状態をリセット
    resetReadyState();

    // 待機オーバーレイを非表示にする
    document.getElementById('matching-overlay').classList.add('hidden');
    document.getElementById('role-select-overlay').classList.add('hidden');

    // 部屋にジョイン
    socket.emit('game:join', { roomId });
  });

  // 準備完了状態リセットヘルパー
  function resetReadyState() {
    isReady = false;
    const btn = document.getElementById('ready-matching-btn');
    if (btn) {
      btn.textContent = '準備OK (Ready)';
      btn.className = 'cyber-btn success-glow';
    }
  }

  // ゲーム状態の更新受信
  socket.on('game:state', (newState) => {
    state = newState;
    updateUI();
  });

  socket.on('disconnect', () => {
    console.warn('対戦ネットワークから切断されました。');
  });
}

/**
 * 役職名の日本語変換
 */
function getNodeRoleNameJa(role) {
  const dict = { adventurer: '冒険家', engineer: 'エンジニア', treasure_hunter: 'トレハ', tycoon: '石油王', witch: '魔女' };
  return dict[role] || role;
}

/**
 * イベントリスナーの登録
 */
function setupEventListeners() {
  // 役職選択カードのクリックイベント
  const roleCards = document.querySelectorAll('.role-card');
  roleCards.forEach(card => {
    card.addEventListener('click', () => {
      roleCards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedRole = card.dataset.role;
    });
  });

  // シングルプレイ (CPU戦) 開始ボタン
  document.getElementById('start-game-btn').addEventListener('click', () => {
    const nameInput = document.getElementById('player-name-input');
    const name = nameInput.value.trim() || '無名エージェント';
    
    // シングルプレイ時は、キューにジョイン後即座に開始要求を送る
    socket.emit('queue:join', { playerName: name, role: selectedRole });
    
    // 一瞬だけ待って即時開始要求を送信
    setTimeout(() => {
      socket.emit('queue:start-immediate');
    }, 100);
  });

  // オンライン対戦 (マルチ) ボタン
  document.getElementById('match-online-btn').addEventListener('click', () => {
    const nameInput = document.getElementById('player-name-input');
    const name = nameInput.value.trim() || 'マルチ対戦者';

    // 待機オーバーレイを表示
    document.getElementById('matching-overlay').classList.remove('hidden');

    // マッチングキューに入る
    socket.emit('queue:join', { playerName: name, role: selectedRole });
  });

  // 準備完了 (Ready) ボタン
  document.getElementById('ready-matching-btn').addEventListener('click', () => {
    isReady = !isReady;
    const btn = document.getElementById('ready-matching-btn');
    if (isReady) {
      btn.textContent = '準備中（キャンセル）';
      btn.className = 'cyber-btn warning-glow';
    } else {
      btn.textContent = '準備OK (Ready)';
      btn.className = 'cyber-btn success-glow';
    }
    socket.emit('queue:ready', { ready: isReady });
  });

  // マッチングキャンセルボタン
  document.getElementById('cancel-matching-btn').addEventListener('click', () => {
    socket.emit('queue:leave');
    resetReadyState();
    document.getElementById('matching-overlay').classList.add('hidden');
  });

  // システム再起動ボタン (初期ロビーに戻る)
  document.getElementById('reset-game-btn').addEventListener('click', () => {
    socket.emit('queue:leave');
    resetReadyState();
    myRoomId = null;
    myPlayerId = null;
    document.getElementById('role-select-overlay').classList.remove('hidden');
  });

  // もう一度プレイする
  document.getElementById('play-again-btn').addEventListener('click', () => {
    myRoomId = null;
    myPlayerId = null;
    document.getElementById('role-select-overlay').classList.remove('hidden');
  });

  // ダイスロール
  document.getElementById('roll-dice-btn').addEventListener('click', () => {
    sendGameAction('roll');
  });

  // ターン終了
  document.getElementById('end-turn-btn').addEventListener('click', () => {
    sendGameAction('end-turn');
  });

  // 戦闘カードスキップ（パス）
  document.getElementById('skip-combat-btn').addEventListener('click', () => {
    sendGameAction('combat:play', { cardValue: 0 });
  });

  // 戦闘からの逃走
  document.getElementById('flee-combat-btn').addEventListener('click', () => {
    sendGameAction('combat:flee');
  });

  // 宝物庫の解錠試行
  document.getElementById('unlock-treasury-btn').addEventListener('click', () => {
    sendGameAction('treasury:unlock', { slots: treasurySlots });
  });

  // 宝物庫からの引き返し
  document.getElementById('treasury-cancel-btn').addEventListener('click', () => {
    sendGameAction('treasury:cancel');
  });

  // マップズーム機能のリスナー登録
  document.getElementById('zoom-in-btn').addEventListener('click', () => {
    zoomLevel = Math.min(2.5, zoomLevel + 0.25);
    updateMapViewBox();
  });
  document.getElementById('zoom-out-btn').addEventListener('click', () => {
    zoomLevel = Math.max(0.75, zoomLevel - 0.25);
    updateMapViewBox();
  });
  document.getElementById('zoom-reset-btn').addEventListener('click', () => {
    zoomLevel = 1.0;
    updateMapViewBox();
  });

  // 戦闘報酬の選択リスナー
  document.getElementById('claim-loot-btn').addEventListener('click', () => {
    sendGameAction('reward:claim', { choice: 'loot' });
  });
  document.getElementById('claim-destroy-btn').addEventListener('click', () => {
    sendGameAction('reward:claim', { choice: 'destroy' });
  });

  // 宝物庫のプラス・マイナスボタン (ローカル入力)
  const plusButtons = document.querySelectorAll('.slot-btn.plus');
  const minusButtons = document.querySelectorAll('.slot-btn.minus');

  plusButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const weight = btn.dataset.weight;
      const activeCount = Object.values(treasurySlots).filter(Boolean).length;
      const meIdx = myPlayerId !== null ? myPlayerId : 0;
      const player = state.players[meIdx];
      
      if (player.threads > activeCount && !treasurySlots[weight]) {
        treasurySlots[weight] = 1;
        updateTreasuryDisplay();
      }
    });
  });

  minusButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const weight = btn.dataset.weight;
      if (treasurySlots[weight]) {
        treasurySlots[weight] = 0;
        updateTreasuryDisplay();
      }
    });
  });
}

/**
 * ゲームアクションをサーバーに送信する共通ヘルパー
 */
function sendGameAction(action, data = {}) {
  if (!myRoomId) return;
  socket.emit('game:action', {
    roomId: myRoomId,
    action,
    data
  });
}

/**
 * 指定のマスへ移動
 */
function selectMove(targetNode) {
  sendGameAction('move', { targetNode });
}

/**
 * 戦闘用カードのプレイ
 */
function playCombatCard(cardValue) {
  sendGameAction('combat:play', { cardValue });
}

/**
 * 最新のゲームステートをUIに同期更新
 */
function updateUI() {
  if (!state) return;

  try {
    const meIdx = myPlayerId !== null ? myPlayerId : 0;
    const isMyTurn = (state.turn === meIdx);

    // 1. ヘッダー情報の更新
    document.getElementById('turn-count').textContent = state.turnCount;
    
    // フェーズ表記
    const phaseEl = document.getElementById('current-phase');
    if (state.phase === 'COMBAT') {
      phaseEl.textContent = 'BATTLE';
      phaseEl.className = 'value text-danger';
    } else {
      phaseEl.textContent = state.phase;
      phaseEl.className = 'value text-cyan';
    }
    
    const activeLabel = document.getElementById('active-player');
    if (state.phase === 'TREASURY') {
      const activePlayer = (state.players && state.players[state.turn]) ? state.players[state.turn] : { name: '-' };
      activeLabel.textContent = activePlayer.name;
      if (state.turn === meIdx) {
        activeLabel.className = 'value text-green';
      } else {
        activeLabel.className = 'value text-cyan';
      }
    } else if (state.phase === 'COMBAT') {
      const cState = state.combatState;
      if (cState && state.players[cState.attacker] && state.players[cState.defender]) {
        activeLabel.textContent = `${state.players[cState.attacker].name} vs ${state.players[cState.defender].name}`;
      } else {
        activeLabel.textContent = '戦闘中';
      }
      activeLabel.className = 'value text-danger';
    } else {
      activeLabel.textContent = '全員同時行動';
      activeLabel.className = 'value text-gold';
    }

    // 2. ステータス情報の更新 (自分のIDを参照)
    const player = (state.players && state.players[meIdx]) ? state.players[meIdx] : { hp: 3000, threads: 0, items: [], hints: [] };
    
    // HPバー
    const hpPercent = (player.hp / 3000) * 100;
    document.getElementById('player-hp-bar').style.width = `${hpPercent}%`;
    document.getElementById('player-hp-text').textContent = `${player.hp} / 3000`;
    
    // 蜘蛛の金糸 (蓄積表示)
    document.getElementById('thread-count').textContent = player.threads;
    document.getElementById('player-threads-total').textContent = player.threads;

    // 宝物庫進入条件（セキュリティ解析）
    const securityEl = document.getElementById('treasury-security-status');
    if (securityEl) {
      const getRequiredThreads = (items) => {
        let mod = 0;
        if (player.role === 'witch' || player.role === 'tycoon') {
          mod += 3;
        }
        const hasRing = items.includes('指輪');
        const hasAmulet = items.includes('アミュレット');
        const hasCrown = items.includes('王冠');

        if (hasRing && hasAmulet && hasCrown) {
          if (player.role === 'treasure_hunter') {
            mod -= 3;
          } else {
            mod -= 2;
          }
        }

        let target = state.baseTarget + mod;
        if (target < 1) target = 1;
        if (target > 15) target = 15;

        let activeBits = 0;
        if (target & 8) activeBits++;
        if (target & 4) activeBits++;
        if (target & 2) activeBits++;
        if (target & 1) activeBits++;

        return activeBits;
      };

      const currentReq = getRequiredThreads(player.items || []);
      const hasAccess = player.threads >= currentReq;

      if (hasAccess) {
        securityEl.innerHTML = `<span class="text-green">【アクセス許可】宝物庫進入可能です。</span><br><span style="font-size: 0.75rem; color: var(--text-muted);">（現在、必要金糸 ${currentReq}本 に対し ${player.threads}本 所持）</span>`;
        securityEl.style.borderLeftColor = 'var(--color-green)';
      } else {
        let text = `<span class="text-danger">【アクセス拒否】結界に弾かれます！</span><br>`;
        const diffThreads = currentReq - player.threads;
        text += `・あと <strong class="text-gold">${diffThreads}本</strong> の蜘蛛の金糸が必要です。<br>`;

        const allItems = ['指輪', 'アミュレット', '王冠'];
        const missingItems = allItems.filter(item => !(player.items || []).includes(item));

        if (missingItems.length > 0) {
          const requiredWithSet = getRequiredThreads([...(player.items || []), ...missingItems]);
          const diffWithSet = requiredWithSet - player.threads;

          if (diffWithSet <= 0) {
            text += `・または、欠けている装備 [${missingItems.join(', ')}] を揃えると、追加の金糸なしで進入可能になります。`;
          } else if (diffWithSet < diffThreads) {
            text += `・または、欠けている装備 [${missingItems.join(', ')}] を揃えた上で、あと <strong class="text-gold">${diffWithSet}本</strong> の金糸を獲得すれば進入可能です。`;
          }
        }
        securityEl.innerHTML = text;
        securityEl.style.borderLeftColor = 'var(--color-pink)';
      }
    }

    // 役職
    document.getElementById('player-role-display').textContent = player.roleName;

    // アイテムバッジ
    const itemList = document.getElementById('item-list');
    itemList.innerHTML = '';
    const possibleItems = ['指輪', 'アミュレット', '王冠'];
    
    let hasItem = false;
    possibleItems.forEach(item => {
      const isCollected = (player.items || []).includes(item);
      if (isCollected) hasItem = true;
      const badge = document.createElement('span');
      badge.className = `badge ${isCollected ? 'item-collected' : 'empty'}`;
      badge.textContent = item;
      itemList.appendChild(badge);
    });
    if (!hasItem) {
      itemList.innerHTML = '<span class="badge empty">なし</span>';
    }

    // 2進数ヒント
    const hintList = document.getElementById('hint-list');
    hintList.innerHTML = '';
    if (!player.hints || player.hints.length === 0) {
      hintList.innerHTML = '<span class="hint-empty">探索でヒントを見つけましょう...</span>';
    } else {
      player.hints.forEach(hint => {
        const hintDiv = document.createElement('div');
        hintDiv.className = 'hint-item';
        hintDiv.textContent = hint.text;
        hintList.appendChild(hintDiv);
      });
    }

    // 3. テキストログの更新
    const logWindow = document.getElementById('log-window');
    logWindow.innerHTML = '';
    state.logs.forEach(log => {
      const logDiv = document.createElement('div');
      logDiv.className = 'log-line';
      
      if (log.includes('勝利') || log.includes('獲得') || log.includes('解錠')) {
        logDiv.classList.add('success');
      } else if (log.includes('ダメージ') || log.includes('バースト') || log.includes('失敗')) {
        logDiv.classList.add('important');
      } else if (log.includes('戦闘') || log.includes('呪い')) {
        logDiv.classList.add('warning');
      }
      
      logDiv.innerHTML = formatLogText(log);
      logWindow.appendChild(logDiv);
    });
    logWindow.scrollTop = logWindow.scrollHeight;

    // 4. マップの描画
    renderMap();

    // 5. コントロールパネルのフェーズ切り替え
    const groups = ['roll', 'move', 'resolve', 'combat', 'combat-reward', 'treasury', 'gameover'];
    groups.forEach(g => {
      document.getElementById(`ctrl-${g}`).classList.add('hidden');
    });

    if (state.phase === 'ROLL') {
      const rolledSelf = state.rolled && state.rolled[meIdx] !== undefined;
      if (!rolledSelf && player.hp > 0) {
        document.getElementById('ctrl-roll').classList.remove('hidden');
      } else {
        document.getElementById('ctrl-resolve').classList.remove('hidden');
        document.querySelector('#ctrl-resolve .prompt-text').textContent = '他のプレイヤーがダイスを振るのを待っています...';
        document.getElementById('end-turn-btn').classList.add('hidden');
      }
    } else if (state.phase === 'MOVE') {
      const movedSelf = state.moved && state.moved[meIdx] !== undefined;
      if (!movedSelf && player.hp > 0) {
        document.getElementById('ctrl-move').classList.remove('hidden');
        const destList = document.getElementById('move-dest-list');
        destList.innerHTML = '';
        const myReachable = state.reachableNodes && state.reachableNodes[meIdx] || [];
        myReachable.forEach(node => {
          const btn = document.createElement('button');
          btn.className = 'cyber-btn-outline small';
          btn.textContent = `マス ${node}`;
          btn.addEventListener('click', () => selectMove(node));
          destList.appendChild(btn);
        });
      } else {
        document.getElementById('ctrl-resolve').classList.remove('hidden');
        document.querySelector('#ctrl-resolve .prompt-text').textContent = '他のプレイヤーが移動先を選択するのを待っています...';
        document.getElementById('end-turn-btn').classList.add('hidden');
      }
    } else if (state.phase === 'RESOLVE') {
      document.getElementById('ctrl-resolve').classList.remove('hidden');
      document.querySelector('#ctrl-resolve .prompt-text').textContent = 'システム処理中...';
      document.getElementById('end-turn-btn').classList.add('hidden');
    } else if (state.phase === 'COMBAT') {
      const cState = state.combatState;
      const isCombatParticipant = cState && (cState.attacker === meIdx || cState.defender === meIdx);
      if (isCombatParticipant) {
        document.getElementById('ctrl-combat').classList.remove('hidden');
        setupCombatUI();
      } else {
        document.getElementById('ctrl-resolve').classList.remove('hidden');
        const pAttacker = state.players[cState.attacker] || { name: 'アタッカー' };
        const pDefender = state.players[cState.defender] || { name: 'ディフェンダー' };
        document.querySelector('#ctrl-resolve .prompt-text').textContent = `戦闘を観戦しています: ${pAttacker.name} vs ${pDefender.name}`;
        document.getElementById('end-turn-btn').classList.add('hidden');
      }
    } else if (state.phase === 'COMBAT_REWARD') {
      const cState = state.combatState;
      if (cState && cState.winner === meIdx) {
        document.getElementById('ctrl-combat-reward').classList.remove('hidden');
      } else {
        document.getElementById('ctrl-resolve').classList.remove('hidden');
        const winnerName = (cState && state.players[cState.winner]) ? state.players[cState.winner].name : '勝者';
        document.querySelector('#ctrl-resolve .prompt-text').textContent = `${winnerName} が勝利報酬を選択しています...`;
        document.getElementById('end-turn-btn').classList.add('hidden');
      }
    } else if (state.phase === 'TREASURY') {
      if (isMyTurn) {
        document.getElementById('ctrl-treasury').classList.remove('hidden');
        updateTreasuryDisplay();
      } else {
        document.getElementById('ctrl-resolve').classList.remove('hidden');
        const challengerName = (state.players && state.players[state.turn]) ? state.players[state.turn].name : '挑戦者';
        document.querySelector('#ctrl-resolve .prompt-text').textContent = `${challengerName} が宝物庫の解錠に挑んでいます！`;
        document.getElementById('end-turn-btn').classList.add('hidden');
      }
    } else if (state.phase === 'GAME_OVER') {
      document.getElementById('ctrl-gameover').classList.remove('hidden');
      const title = document.getElementById('game-over-title');
      const desc = document.getElementById('game-over-desc');
      
      if (state.winner === meIdx) {
        title.textContent = 'MISSION ACCOMPLISHED';
        title.className = 'glow-text text-green';
        desc.textContent = '宝物庫の解錠に成功しました！秘宝はあなたのものです。おめでとうございます！';
      } else {
        title.textContent = 'MISSION FAILED';
        title.className = 'glow-text text-danger';
        const winnerName = (state.players && state.players[state.winner]) ? state.players[state.winner].name : '他プレイヤー';
        desc.textContent = `宝物庫は ${winnerName} によって解錠されてしまいました。ミッション失敗です。`;
      }
    }
  } catch (err) {
    console.error('UIの更新中にエラーが発生しました:', err);
  }
}

/**
 * 蜘蛛の巣マップ (SVG) の動的描画
 */
function getRingLevel(node) {
  const n = parseInt(node);
  if (n === 0) return 0;
  if (n >= 31) return 1;
  if (n >= 25) return 2;
  if (n >= 13) return 3;
  return 4;
}

function renderMap() {
  const svg = document.getElementById('spider-map');
  svg.innerHTML = '';

  // 1. 同心円のウェブ（蜘蛛の巣の横糸）を描画 (4層構造)
  const rings = [R_INNER, R_MID_INNER, R_MID_OUTER, R_OUTER];
  rings.forEach(r => {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', 0);
    circle.setAttribute('cy', 0);
    circle.setAttribute('r', r);
    circle.className.baseVal = 'map-web-line';
    svg.appendChild(circle);
  });

  // 2. 放射状のリンク（蜘蛛の巣の縦糸）を描画
  const renderedLinks = new Set();
  const connections = {
    0: [31, 32, 33],
    1: [2, 12, 13], 2: [1, 3, 14], 3: [2, 4, 15], 4: [3, 5, 16],
    5: [4, 6, 17], 6: [5, 7, 18], 7: [6, 8, 19], 8: [7, 9, 20],
    9: [8, 10, 21], 10: [9, 11, 22], 11: [10, 12, 23], 12: [11, 1, 24],
    13: [14, 24, 1, 25], 14: [13, 15, 2, 25], 15: [14, 16, 3, 26], 16: [15, 17, 4, 26],
    17: [16, 18, 5, 27], 18: [17, 19, 6, 27], 19: [18, 20, 7, 28], 20: [19, 21, 8, 28],
    21: [20, 22, 9, 29], 22: [21, 23, 10, 29], 23: [22, 24, 11, 30], 24: [23, 13, 12, 30],
    25: [26, 30, 13, 14, 31], 26: [25, 27, 15, 16, 31], 27: [26, 28, 17, 18, 32],
    28: [27, 29, 19, 20, 32], 29: [28, 30, 21, 22, 33], 30: [29, 25, 23, 24, 33],
    31: [32, 33, 25, 26, 0], 32: [31, 33, 27, 28, 0], 33: [32, 31, 29, 30, 0]
  };

  for (const fromNode in connections) {
    const targets = connections[fromNode];
    const fromPos = nodePositions[fromNode];
    
    targets.forEach(toNode => {
      const linkKey = [Math.min(fromNode, toNode), Math.max(fromNode, toNode)].join('-');
      if (!renderedLinks.has(linkKey)) {
        renderedLinks.add(linkKey);
        
        const toPos = nodePositions[toNode];
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', fromPos.x);
        line.setAttribute('y1', fromPos.y);
        line.setAttribute('x2', toPos.x);
        line.setAttribute('y2', toPos.y);
        
        const isRadial = (getRingLevel(fromNode) !== getRingLevel(toNode));
        line.className.baseVal = isRadial ? 'map-link radial' : 'map-link';
        svg.appendChild(line);
      }
    });
  }

  // 3. マスの描画 (ノード)
  const defaultNodeTypes = {
    0: 'TREASURY',
    1: 'ITEM', 2: 'EVENT', 3: 'MODIFIER', 4: 'TRAP',
    5: 'ITEM', 6: 'EVENT', 7: 'MODIFIER', 8: 'TRAP',
    9: 'ITEM', 10: 'EVENT', 11: 'MODIFIER', 12: 'TRAP',
    13: 'ITEM', 14: 'EVENT', 15: 'MODIFIER', 16: 'TRAP',
    17: 'ITEM', 18: 'EVENT', 19: 'MODIFIER', 20: 'TRAP',
    21: 'ITEM', 22: 'EVENT', 23: 'MODIFIER', 24: 'TRAP',
    25: 'ITEM', 26: 'EVENT', 27: 'MODIFIER', 28: 'TRAP',
    29: 'ITEM', 30: 'EVENT',
    31: 'ITEM', 32: 'EVENT', 33: 'MODIFIER'
  };

  const nodeTypes = (state && state.nodeTypes) ? state.nodeTypes : defaultNodeTypes;
  const meIdx = myPlayerId !== null ? myPlayerId : 0;

  for (const nodeId in nodePositions) {
    const pos = nodePositions[nodeId];
    const type = nodeTypes[nodeId];
    
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', pos.x);
    circle.setAttribute('cy', pos.y);
    circle.setAttribute('r', nodeId === '0' ? 16 : 10);
    
    let typeClass = 'node-item';
    if (type === 'TREASURY') typeClass = 'node-treasury';
    else if (type === 'EVENT') typeClass = 'node-event';
    else if (type === 'MODIFIER') typeClass = 'node-modifier';
    else if (type === 'TRAP') typeClass = 'node-trap';
    
    circle.className.baseVal = `map-node ${typeClass}`;
    
    // 移動可能ならハイライト
    const myReachable = state.reachableNodes && state.reachableNodes[meIdx] || [];
    const movedSelf = state.moved && state.moved[meIdx] !== undefined;
    if (state.phase === 'MOVE' && !movedSelf && myReachable.includes(parseInt(nodeId))) {
      circle.className.baseVal += ' node-highlight';
      circle.addEventListener('click', () => selectMove(parseInt(nodeId)));
    }

    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `マス ${nodeId}: ${getNodeTypeNameJa(type)}`;
    circle.appendChild(title);
    svg.appendChild(circle);

    if (nodeId !== '0') {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', pos.x);
      text.setAttribute('y', pos.y);
      text.className.baseVal = 'node-text';
      text.textContent = nodeId;
      svg.appendChild(text);
    }
  }

  // 4. プレイヤーアバターの描画 (重なりズレ対応)
  const playersAtNode = {};
  state.players.forEach(p => {
    if (!playersAtNode[p.pos]) {
      playersAtNode[p.pos] = [];
    }
    playersAtNode[p.pos].push(p);
  });

  for (const posId in playersAtNode) {
    const list = playersAtNode[posId];
    const basePos = nodePositions[posId];
    
    list.forEach((p, index) => {
      let drawX = basePos.x;
      let drawY = basePos.y;

      if (list.length > 1) {
        const offsetRadius = 12;
        const angle = (index * 360) / list.length;
        const rad = degToRad(angle);
        drawX += Math.round(offsetRadius * Math.cos(rad));
        drawY += Math.round(-offsetRadius * Math.sin(rad));
      }

      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      marker.setAttribute('x', drawX);
      marker.setAttribute('y', drawY);
      
      let markerClass = 'player-marker pm-cpu1';
      if (p.id === meIdx) markerClass = 'player-marker pm-player';
      else if (p.id === (meIdx + 1) % 5) markerClass = 'player-marker pm-cpu1';
      else if (p.id === (meIdx + 2) % 5) markerClass = 'player-marker pm-cpu2';
      else if (p.id === (meIdx + 3) % 5) markerClass = 'player-marker pm-cpu3';
      else if (p.id === (meIdx + 4) % 5) markerClass = 'player-marker pm-cpu4';
      
      marker.className.baseVal = markerClass;
      // プレイヤー名の頭文字を表示
      marker.textContent = p.name.substring(0, 1).toUpperCase();

      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${p.name} (${p.roleName}) ${p.id === meIdx ? '(あなた)' : ''} \nHP: ${p.hp}\n金糸: ${p.threads}`;
      marker.appendChild(title);

      svg.appendChild(marker);
    });
  }
}

/**
 * マスタイプ日本語表記
 */
function getNodeTypeNameJa(type) {
  switch (type) {
    case 'TREASURY': return '中央宝物庫';
    case 'ITEM': return '装備アイテムマス';
    case 'EVENT': return '蜘蛛の金糸 / ヒントマス';
    case 'MODIFIER': return '蜘蛛の巣 / 強風マス';
    case 'TRAP': return '罠マス';
    default: return '未知のマス';
  }
}

/**
 * 戦闘UIの更新
 */
function setupCombatUI() {
  const cState = state.combatState;
  if (!cState) return;

  const meIdx = myPlayerId !== null ? myPlayerId : 0;
  const isMeAttacker = (cState.attacker === meIdx);
  const opponentId = isMeAttacker ? cState.defender : cState.attacker;
  
  const player = state.players[meIdx];
  const opponent = state.players[opponentId];

  // 名前の設定
  document.getElementById('combat-cpu-name').textContent = opponent.name;

  // 累積値の表示
  const mySum = isMeAttacker ? cState.attackerSum : cState.defenderSum;
  const oppSum = isMeAttacker ? cState.defenderSum : cState.attackerSum;

  document.getElementById('combat-player-sum').textContent = mySum;
  document.getElementById('combat-cpu-sum').textContent = oppSum;

  // バースト危険度 (形容詞表示)
  const pSafety = document.getElementById('combat-player-safety');
  const oSafety = document.getElementById('combat-cpu-safety');

  const pText = getBurstLevelText(mySum);
  const oText = getBurstLevelText(oppSum);

  pSafety.textContent = pText;
  pSafety.className = `safety-badge ${getBurstLevelClass(pText)}`;

  oSafety.textContent = oText;
  oSafety.className = `safety-badge ${getBurstLevelClass(oText)}`;

  // オンライン対戦用: 相手がカードセット完了しているか
  const hasOpponentPlayed = (cState.plays[opponentId] !== undefined);
  const hasMePlayed = (cState.plays[meIdx] !== undefined);

  if (hasOpponentPlayed) {
    oSafety.textContent = `${oText} (準備完了)`;
    oSafety.className += ' text-green';
  }

  // 手札カードの描画
  const handDiv = document.getElementById('combat-hand');
  handDiv.innerHTML = '';

  if (hasMePlayed) {
    // 自分がすでにカードをセットしている場合は待機表示
    handDiv.innerHTML = '<span style="color: var(--color-gold); font-size: 0.85rem; font-family: var(--font-mono);">対戦相手のカード公開を待っています...</span>';
  } else {
    player.cards.forEach(cardVal => {
      const card = document.createElement('div');
      card.className = 'cyber-card';
      card.innerHTML = `
        <span class="value">${cardVal}</span>
        <span class="card-glow-bg">CARD</span>
      `;
      card.addEventListener('click', () => {
        playCombatCard(cardVal);
      });
      handDiv.appendChild(card);
    });
  }

  // 逃走ボタンとスキップボタンの非表示制御
  const fleeBtn = document.getElementById('flee-combat-btn');
  const skipBtn = document.getElementById('skip-combat-btn');
  if (hasMePlayed) {
    fleeBtn.classList.add('hidden');
    skipBtn.classList.add('hidden');
  } else {
    fleeBtn.classList.remove('hidden');
    skipBtn.classList.remove('hidden');
  }
}

/**
 * バーストレベルクラス
 */
function getBurstLevelClass(text) {
  if (text === '安全') return 'safety-safe';
  if (text === '微熱') return 'safety-warm';
  if (text === '過熱') return 'safety-hot';
  return 'safety-critical';
}

/**
 * バーストレベルテキスト
 */
function getBurstLevelText(sum) {
  if (sum <= 800) return '安全';
  if (sum <= 1500) return '微熱';
  if (sum <= 1900) return '過熱';
  return '臨界点';
}

/**
 * 宝物庫投入UIの更新
 */
function updateTreasuryDisplay() {
  const meIdx = myPlayerId !== null ? myPlayerId : 0;
  const player = state ? state.players[meIdx] : { threads: 0 };
  let currentInputSum = 0;
  let activeSlotsCount = 0;

  const weights = ['8', '4', '2', '1'];
  weights.forEach(w => {
    const active = treasurySlots[w] === 1;
    const lockSlot = document.querySelector(`.lock-slot[data-weight="${w}"]`);
    const valSpan = lockSlot.querySelector('.slot-val');
    
    valSpan.textContent = active ? '1' : '0';
    if (active) {
      lockSlot.style.borderColor = 'var(--color-gold)';
      lockSlot.style.boxShadow = 'var(--glow-gold)';
      currentInputSum += parseInt(w);
      activeSlotsCount++;
    } else {
      lockSlot.style.borderColor = 'rgba(255,183,0,0.2)';
      lockSlot.style.boxShadow = 'none';
    }
  });

  document.getElementById('slots-sum-display').textContent = currentInputSum;
  document.getElementById('slots-cost-display').textContent = activeSlotsCount;
}

/**
 * ログカラーリング
 */
function formatLogText(text) {
  let html = escapeHTML(text);

  // プレイヤー名/CPU名の色分け (動的にstate.players内の名前を着色する)
  if (state && state.players) {
    const meIdx = myPlayerId !== null ? myPlayerId : 0;
    state.players.forEach(p => {
      // プレイヤーごとに正規表現で置換
      const escName = escapeHTML(p.name);
      const regex = new RegExp(escName, 'g');
      
      let colorClass = 'log-c1-name';
      if (p.id === meIdx) colorClass = 'log-p-name';
      else if (p.id === (meIdx + 1) % 4) colorClass = 'log-c1-name';
      else if (p.id === (meIdx + 2) % 4) colorClass = 'log-c2-name';
      else if (p.id === (meIdx + 3) % 4) colorClass = 'log-c3-name';

      html = html.replace(regex, `<span class="${colorClass}">${escName}</span>`);
    });
  }

  // アクションキーワード
  html = html.replace(/(蜘蛛の金糸|金糸)/g, '<span class="log-kw-gold">$1</span>');
  html = html.replace(/(バースト|臨界点突破|限界突破)/g, '<span class="log-kw-danger">$1</span>');
  html = html.replace(/(HP-\d+|ダメージ|罠|ペナルティ|自滅|失敗)/g, '<span class="log-kw-damage">$1</span>');
  html = html.replace(/(勝利|解錠|成功|MISSION ACCOMPLISHED)/g, '<span class="log-kw-success">$1</span>');
  html = html.replace(/(強奪|略奪|呪い|呪術|精神を削り)/g, '<span class="log-kw-warning">$1</span>');

  return html;
}

/**
 * HTMLエスケープ
 */
function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
