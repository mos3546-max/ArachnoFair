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
let customRoomName = null;
let isInQueue = false; // 通常マッチングキュー待機中フラグ

// ゲームのローカルステート
let state = null;

// 宝物庫の解錠用スロットに入力された金糸数
let treasurySlots = { '8': 0, '4': 0, '2': 0, '1': 0 };

// 役職選択状態
let selectedRole = 'adventurer';

// マスの物理座標マッピング (SVG中心を 0, 0 としたときの座標)
const nodePositions = {};

// ズーム値と移動オフセット
let zoomLevel = 1.0;
let panX = 0;
let panY = 0;

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
  const x = -w / 2 + panX;
  const y = -h / 2 + panY;
  const svg = document.getElementById('spider-map');
  if (svg) {
    svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  }
}

/**
 * マップのドラッグ移動・ピンチズーム・マウス操作を設定する
 */
function setupMapTouchEvents() {
  const svg = document.getElementById('spider-map');
  if (!svg) return;

  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let startPanX = 0;
  let startPanY = 0;

  // ピンチズーム用の状態
  let startDistance = 0;
  let startZoom = 1.0;
  let isPinching = false;

  // 2点間の距離を計算するヘルパー
  const getDistance = (t1, t2) => {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // タッチ操作（モバイル）
  svg.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      isDragging = true;
      isPinching = false;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startPanX = panX;
      startPanY = panY;
    } else if (e.touches.length === 2) {
      isDragging = false;
      isPinching = true;
      startDistance = getDistance(e.touches[0], e.touches[1]);
      startZoom = zoomLevel;
    }
  }, { passive: true });

  svg.addEventListener('touchmove', (e) => {
    if (isDragging && e.touches.length === 1) {
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      const rect = svg.getBoundingClientRect();
      const scaleX = 500 / rect.width / zoomLevel;
      const scaleY = 500 / rect.height / zoomLevel;

      panX = startPanX - dx * scaleX;
      panY = startPanY - dy * scaleY;
      updateMapViewBox();
    } else if (isPinching && e.touches.length === 2) {
      const distance = getDistance(e.touches[0], e.touches[1]);
      if (startDistance > 0) {
        const ratio = distance / startDistance;
        zoomLevel = Math.max(0.5, Math.min(3.0, startZoom * ratio));
        updateMapViewBox();
      }
    }
  }, { passive: true });

  svg.addEventListener('touchend', () => {
    isDragging = false;
    isPinching = false;
  }, { passive: true });

  // マウス操作（PC）
  svg.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // 左クリックのみ
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startPanX = panX;
    startPanY = panY;
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const rect = svg.getBoundingClientRect();
    const scaleX = 500 / rect.width / zoomLevel;
    const scaleY = 500 / rect.height / zoomLevel;

    panX = startPanX - dx * scaleX;
    panY = startPanY - dy * scaleY;
    updateMapViewBox();
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
  });

  // マウスホイールでのズーム
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = 1.1;
    if (e.deltaY < 0) {
      zoomLevel = Math.min(3.0, zoomLevel * zoomFactor);
    } else {
      zoomLevel = Math.max(0.5, zoomLevel / zoomFactor);
    }
    updateMapViewBox();
  }, { passive: false });
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
  setupMapTouchEvents();
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
    // すでにゲーム中ならロビー更新は無視する
    if (myRoomId) return;

    // 自分がマッチング中でない場合は、遅れて届いたイベントなどで誤作動しないように隠し、ガードする
    if (!isInQueue && !customRoomName) {
      document.getElementById('matching-overlay').classList.add('hidden');
      document.getElementById('role-select-overlay').classList.remove('hidden');
      return;
    }

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

    // 2名以上のプレイヤーがいて、かつ全員の準備が完了している場合にのみ対戦開始ボタンを表示
    const startMatchBtn = document.getElementById('start-match-btn');
    if (startMatchBtn) {
      const allReady = (players.length >= 2 && players.every(p => p.ready));
      if (allReady) {
        startMatchBtn.classList.remove('hidden');
      } else {
        startMatchBtn.classList.add('hidden');
      }
    }
  });

  // マッチング成立
  socket.on('match:success', ({ roomId, playerId }) => {
    console.log(`マッチング成立！ RoomID: ${roomId}, PlayerID: ${playerId}`);
    myRoomId = roomId;
    myPlayerId = playerId;
    isInQueue = false; // マッチ成立のためキュー状態終了

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
    const startMatchBtn = document.getElementById('start-match-btn');
    if (startMatchBtn) {
      startMatchBtn.classList.add('hidden');
    }
  }

  // ゲーム状態の更新受信
  socket.on('game:state', (newState) => {
    state = newState;
    updateUI();
  });

  // カスタムルームの更新受信
  socket.on('custom-room:update', ({ roomName, players }) => {
    // すでにゲーム中ならロビー更新は無視する
    if (myRoomId) return;

    // 自分が退出済み（カスタムルーム名が不一致またはnull）ならガード
    if (!customRoomName || customRoomName !== roomName) {
      document.getElementById('matching-overlay').classList.add('hidden');
      document.getElementById('role-select-overlay').classList.remove('hidden');
      return;
    }

    customRoomName = roomName;
    
    const subtitle = document.querySelector('#matching-overlay .subtitle');
    if (subtitle) {
      subtitle.innerHTML = `合言葉 <span class="text-gold" style="font-weight:bold;">[ ${escapeHTML(roomName)} ]</span> のカスタムルームで待機中。全員が準備完了を押すとゲームが始まります。`;
    }
    
    document.getElementById('matching-count').textContent = players.length;
    const listEl = document.getElementById('matching-player-list');
    listEl.innerHTML = '';

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
          <span class="text-gold">> ${escapeHTML(p.name)}</span> 
          <span style="font-size: 0.75rem; color: var(--text-muted);">(${getNodeRoleNameJa(p.role)})</span>
        </div>
        ${readyBadge}
      `;
      listEl.appendChild(item);
    });

    // 1名以上のプレイヤーがいて、かつ全員の準備が完了している場合にのみ対戦開始ボタンを表示
    const startMatchBtn = document.getElementById('start-match-btn');
    if (startMatchBtn) {
      const allReady = (players.length >= 1 && players.every(p => p.ready));
      if (allReady) {
        startMatchBtn.classList.remove('hidden');
      } else {
        startMatchBtn.classList.add('hidden');
      }
    }
  });

  // カスタムルーム関連エラー
  socket.on('custom-room:error', ({ message }) => {
    alert(message);
    document.getElementById('matching-overlay').classList.add('hidden');
    customRoomName = null;
    resetReadyState();
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
  document.getElementById('start-game-btn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const nameInput = document.getElementById('player-name-input');
    const name = nameInput.value.trim() || '無名エージェント';
    
    isInQueue = true; // シングルプレイ時も内部的にはキュー経由で開始するため一時的にtrue
    customRoomName = null;
    
    // シングルプレイ時は、キューにジョイン後即座に開始要求を送る
    socket.emit('queue:join', { playerName: name, role: selectedRole });
    
    // 一瞬だけ待って即時開始要求を送信
    setTimeout(() => {
      socket.emit('queue:start-immediate');
    }, 100);
  });

  // オンライン対戦 (マルチ) ボタン
  document.getElementById('match-online-btn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const nameInput = document.getElementById('player-name-input');
    const name = nameInput.value.trim() || 'マルチ対戦者';

    const roomInput = document.getElementById('room-name-input');
    const roomName = roomInput.value.trim();

    // 待機オーバーレイを表示
    document.getElementById('matching-overlay').classList.remove('hidden');

    if (roomName) {
      // カスタムルームに入る
      customRoomName = roomName;
      isInQueue = false;
      socket.emit('custom-room:join', { roomName, playerName: name, role: selectedRole });
    } else {
      // 通常のマッチングキューに入る
      customRoomName = null;
      isInQueue = true;
      const subtitle = document.querySelector('#matching-overlay .subtitle');
      if (subtitle) {
        subtitle.textContent = '対戦ネットワークに接続中。全員が準備完了を押すとゲームが始まります。';
      }
      socket.emit('queue:join', { playerName: name, role: selectedRole });
    }
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
    
    if (customRoomName) {
      socket.emit('custom-room:ready', { roomName: customRoomName, ready: isReady });
    } else {
      socket.emit('queue:ready', { ready: isReady });
    }
  });

  // 対戦開始ボタン
  document.getElementById('start-match-btn').addEventListener('click', () => {
    if (customRoomName) {
      socket.emit('custom-room:start-match', { roomName: customRoomName });
    } else {
      socket.emit('queue:start-match');
    }
  });

  // ルール説明書を開くボタン
  document.getElementById('show-rules-btn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    // 役職選択画面を隠し、ルール画面を表示する
    document.getElementById('role-select-overlay').classList.add('hidden');
    document.getElementById('rules-overlay').classList.remove('hidden');
  });

  // ルール画面から「ゲームに行く（戻る）」ボタン
  document.getElementById('back-to-home-btn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    // ルール画面を隠し、役職選択画面を表示する
    document.getElementById('rules-overlay').classList.add('hidden');
    document.getElementById('role-select-overlay').classList.remove('hidden');
  });

  // マッチングキャンセルボタン (ホームに戻る)
  document.getElementById('cancel-matching-btn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (customRoomName) {
      socket.emit('custom-room:leave', { roomName: customRoomName });
      customRoomName = null;
    } else {
      socket.emit('queue:leave');
    }
    isInQueue = false; // キュー離脱
    resetReadyState();

    setTimeout(() => {
      document.getElementById('matching-overlay').classList.add('hidden');
      document.getElementById('role-select-overlay').classList.remove('hidden'); // 確実にホームに戻す
    }, 50);
  });

  // システム再起動ボタン (初期ロビーに戻る)
  document.getElementById('reset-game-btn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (customRoomName) {
      socket.emit('custom-room:leave', { roomName: customRoomName });
      customRoomName = null;
    } else {
      socket.emit('queue:leave');
    }
    isInQueue = false; // キュー離脱
    resetReadyState();
    myRoomId = null;
    myPlayerId = null;

    setTimeout(() => {
      document.getElementById('matching-overlay').classList.add('hidden');
      document.getElementById('role-select-overlay').classList.remove('hidden');
    }, 50);
  });

  // もう一度プレイする
  document.getElementById('play-again-btn').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    myRoomId = null;
    myPlayerId = null;
    isInQueue = false;
    customRoomName = null;

    setTimeout(() => {
      document.getElementById('matching-overlay').classList.add('hidden');
      document.getElementById('role-select-overlay').classList.remove('hidden');
    }, 50);
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
  document.getElementById('claim-thread-btn').addEventListener('click', () => {
    sendGameAction('reward:claim', { choice: 'thread' });
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
      const totalAllocated = Object.values(treasurySlots).reduce((a, b) => a + b, 0);
      const meIdx = myPlayerId !== null ? myPlayerId : 0;
      const player = state.players[meIdx];
      
      if (player.threads > totalAllocated) {
        treasurySlots[weight] = (treasurySlots[weight] || 0) + 1;
        updateTreasuryDisplay();
      }
    });
  });

  minusButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const weight = btn.dataset.weight;
      if (treasurySlots[weight] && treasurySlots[weight] > 0) {
        treasurySlots[weight] -= 1;
        updateTreasuryDisplay();
      }
    });
  });

  // ログパネルの開閉（モバイル用）
  const logPanelHeader = document.getElementById('log-panel-header');
  if (logPanelHeader) {
    logPanelHeader.addEventListener('click', () => {
      if (window.innerWidth <= 767) {
        const logPanel = document.querySelector('.log-panel');
        if (logPanel) {
          logPanel.classList.toggle('expanded');
          const toggleIcon = document.getElementById('log-toggle-icon');
          if (toggleIcon) {
            toggleIcon.textContent = logPanel.classList.contains('expanded') ? '▼' : '▲';
          }
        }
      }
    });
  }
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
      const getRequiredThreads = () => {
        if (player.role === 'adventurer' || player.role === 'engineer') return 5;
        if (player.role === 'treasure_hunter') return 7;
        if (player.role === 'witch') return 7;
        if (player.role === 'tycoon') return 9;
        return 5;
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

    // 目標値と獲得したヒントの表示
    const hintList = document.getElementById('hint-list');
    const targetN = player.target || 20;
    
    // アイテム（指輪、アミュレット、王冠）がすべて揃っているかチェック
    const requiredItems = ['指輪', 'アミュレット', '王冠'];
    const hasAllItems = requiredItems.every(item => (player.items || []).includes(item));
    
    const displayTarget = hasAllItems ? targetN : '???';
    const targetGlow = hasAllItems ? 'var(--glow-cyan)' : 'rgba(255,255,255,0.1)';
    
    let hintsHtml = '';
    if (player.hints && player.hints.length > 0) {
      hintsHtml = player.hints.map(h => `<div class="text-green" style="margin-top: 4px; font-size: 0.75rem;">✔ ${h.text}</div>`).join('');
    } else {
      hintsHtml = '<div class="text-muted" style="margin-top: 4px; font-size: 0.75rem;">獲得したヒントはありません。</div>';
    }

    hintList.innerHTML = `
      <div style="font-size: 0.8rem; font-family: var(--font-mono); line-height: 1.5; color: var(--text-main);">
        基本解錠目標値: <strong class="text-cyan" style="text-shadow: ${targetGlow}; font-size: 1rem;">${displayTarget}</strong>
        ${!hasAllItems ? '<br><span style="font-size: 0.7rem; color: var(--color-gold); font-weight: bold;">(指輪・アミュレット・王冠をすべて集めると開示)</span>' : ''}<br>
        <span style="font-size: 0.7rem; color: var(--text-muted);">※必要金糸数: 冒険家/エンジニアは最小解錠金糸数、ハンター/魔女は+2本、石油王は常に9本</span>
        <div style="margin-top: 10px; border-top: 1px dashed rgba(0, 240, 255, 0.2); padding-top: 8px;">
          <strong style="color: var(--color-gold);">【獲得したヒント】</strong>
          ${hintsHtml}
        </div>
      </div>
    `;

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
    const isReachable = state.phase === 'MOVE' && !movedSelf && myReachable.includes(parseInt(nodeId));
    if (isReachable) {
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
      // 移動可能なマスなら text-highlight クラスを追加
      text.className.baseVal = `node-text ${isReachable ? 'text-highlight' : ''}`;
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
        const offsetRadius = 13;
        const angle = (index * 360) / list.length;
        const rad = degToRad(angle);
        drawX += Math.round(offsetRadius * Math.cos(rad));
        drawY += Math.round(-offsetRadius * Math.sin(rad));
      } else {
        // プレイヤーが1人だけの場合は、数字と重ならないよう円の上にシフト
        drawY -= (posId === '0' ? 22 : 14);
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

  // タイトル表示
  const combatTitle = document.querySelector('#ctrl-combat h3');
  if (combatTitle) {
    if (cState.isTreasuryCombat) {
      combatTitle.textContent = 'TREASURY BATTLE';
      combatTitle.className = 'glow-text text-gold';
    } else {
      combatTitle.textContent = 'BATTLE IN PROGRESS';
      combatTitle.className = 'glow-text text-danger';
    }
  }

  // 名前の設定
  document.getElementById('combat-cpu-name').textContent = opponent.name;

  // バースト上限提示プロンプトの動的表示更新
  const myLimit = player.role === 'witch' ? 2500 : (player.role === 'tycoon' ? 1800 : 2000);
  document.querySelector('#ctrl-combat .prompt-text').textContent = `手札からカードを選択して出してください（累積が ${myLimit} を超えるとバースト自滅）。`;

  // 累積値の表示
  const mySum = isMeAttacker ? cState.attackerSum : cState.defenderSum;
  const oppSum = isMeAttacker ? cState.defenderSum : cState.attackerSum;

  document.getElementById('combat-player-sum').textContent = mySum;
  document.getElementById('combat-cpu-sum').textContent = oppSum;

  // バースト危険度 (形容詞表示)
  const pSafety = document.getElementById('combat-player-safety');
  const oSafety = document.getElementById('combat-cpu-safety');

  const pText = getBurstLevelText(mySum, player.role);
  const oText = getBurstLevelText(oppSum, opponent.role);

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
function getBurstLevelText(sum, role) {
  let limit = 2000;
  if (role === 'witch') limit = 2500;
  else if (role === 'tycoon') limit = 1800;

  if (sum <= limit * 0.4) return '安全';
  if (sum <= limit * 0.75) return '微熱';
  if (sum <= limit) return '過熱';
  return '臨界点 (バースト)';
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
    const activeCount = treasurySlots[w] || 0;
    const lockSlot = document.querySelector(`.lock-slot[data-weight="${w}"]`);
    const valSpan = lockSlot.querySelector('.slot-val');
    
    valSpan.textContent = activeCount;
    if (activeCount > 0) {
      lockSlot.style.borderColor = 'var(--color-gold)';
      lockSlot.style.boxShadow = 'var(--glow-gold)';
      currentInputSum += parseInt(w) * activeCount;
      activeSlotsCount += activeCount;
    } else {
      lockSlot.style.borderColor = 'rgba(255,183,0,0.2)';
      lockSlot.style.boxShadow = 'none';
    }
  });

  let displayCost = activeSlotsCount;
  if (player && player.role === 'tycoon') {
    displayCost = 9;
  }

  document.getElementById('slots-sum-display').textContent = currentInputSum;
  document.getElementById('slots-cost-display').textContent = displayCost;
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
