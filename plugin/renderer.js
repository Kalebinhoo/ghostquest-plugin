(function () {
  'use strict';

  if (window.__ghostquestUI) return;

  const log = (...args) => console.log(
    '%c[GhostQuest]',
    'color:#0b0b0b;background:#9ef;padding:2px 6px;border-radius:4px;font-weight:700',
    ...args.map((arg) => {
      if (arg instanceof Error) return arg.stack || arg.message;
      if (arg && typeof arg === 'object') {
        try { return JSON.stringify(arg); } catch (_) { return String(arg); }
      }
      return arg;
    })
  );
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const TASK_PRIORITY = [
    'WATCH_VIDEO',
    'WATCH_VIDEO_ON_MOBILE',
    'PLAY_ON_DESKTOP',
    'PLAY_ON_DESKTOP_V2',
    'STREAM_ON_DESKTOP',
    'PLAY_ACTIVITY',
    'ACHIEVEMENT_IN_ACTIVITY',
    'ACHIEVEMENT_IN_GAME',
  ];

  const TASK_LABELS = {
    WATCH_VIDEO: 'assistir vídeo',
    WATCH_VIDEO_ON_MOBILE: 'assistir vídeo (mobile)',
    PLAY_ON_DESKTOP: 'jogar no PC',
    PLAY_ON_DESKTOP_V2: 'jogar no PC',
    STREAM_ON_DESKTOP: 'transmitir',
    PLAY_ACTIVITY: 'atividade',
    ACHIEVEMENT_IN_GAME: 'conquista no jogo',
    ACHIEVEMENT_IN_ACTIVITY: 'conquista na atividade',
    PLAY_ON_XBOX: 'Xbox',
    PLAY_ON_PLAYSTATION: 'PlayStation',
  };

  // QuestContentType (docs.discord.food/resources/quests) — o endpoint de enroll
  // exige um inteiro, não a string de placement.
  const QUEST_CONTENT_TYPES = {
    GIFT_INVENTORY_SETTINGS_BADGE: 0,
    QUEST_BAR: 1,
    QUEST_INVENTORY_CARD: 2,
    QUESTS_EMBED: 3,
    ACTIVITY_PANEL: 4,
    QUEST_LIVE_STREAM: 5,
    MEMBERS_LIST: 6,
    QUEST_BADGE: 7,
    GIFT_INVENTORY_FOR_YOU: 8,
    GIFT_INVENTORY_OTHER: 9,
    QUEST_BAR_V2: 10,
    QUEST_HOME_DESKTOP: 11,
    QUEST_HOME_MOBILE: 12,
    QUEST_BAR_MOBILE: 13,
    THIRD_PARTY_APP: 14,
    QUEST_BOTTOM_SHEET: 15,
    QUEST_EMBED_MOBILE: 16,
    DISCOVERY_SIDEBAR: 18,
    QUEST_SHARE_LINK: 19,
    CONNECTIONS_MODAL: 20,
    DISCOVERY_COMPASS: 21,
    TROPHY_CASE_CARD: 22,
    VIDEO_MODAL: 23,
    REWARD_MODAL: 25,
    // apelidos usados por configs antigas
    STORE: 11,
    HOME: 11,
    QUEST_PAGE: 11,
    QUEST_HOME: 11,
    QUEST_BAR_HOME: 1,
  };

  // ---------------------------------------------------------------- webpack

  function getWpRequire() {
    const global = window.webpackChunkdiscord_app;
    if (!global) return null;

    let req = null;

    try {
      const returned = global.push([[Symbol('GhostQuest')], {}, (r) => { req = r; return r; }]);
      if (typeof returned === 'function') req = returned;
      global.pop();
    } catch (_) {}

    if (!req) {
      try {
        const fallback = global.push([[Symbol('GhostQuest')], {}, (r) => r]);
        if (typeof fallback === 'function') req = fallback;
        global.pop();
      } catch (_) {}
    }

    return req;
  }

  function waitForWebpack(timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function tick() {
        const req = getWpRequire();
        if (req && req.c) return resolve(req);
        if (Date.now() - start > timeoutMs) return reject(new Error('webpack não carregou'));
        setTimeout(tick, 300);
      })();
    });
  }

  function* moduleValues(req) {
    for (const id in req.c) {
      const mod = req.c[id];
      if (!mod || !mod.exports) continue;

      const exp = mod.exports;
      yield exp;

      if (exp && typeof exp === 'object') {
        for (const key of Object.keys(exp)) {
          let value;
          try { value = exp[key]; } catch (_) { continue; }
          if (value && (typeof value === 'object' || typeof value === 'function')) yield value;
        }
      }
    }
  }

  function findModule(req, predicate) {
    for (const value of moduleValues(req)) {
      try {
        if (predicate(value)) return value;
      } catch (_) {}
    }
    return null;
  }

  function safeGet(obj, key) {
    try { return obj[key]; } catch (_) { return undefined; }
  }

  function looksLikeApi(m) {
    if (!m || (typeof m !== 'object' && typeof m !== 'function')) return 0;

    const get = safeGet(m, 'get');
    const post = safeGet(m, 'post');
    if (typeof get !== 'function' || typeof post !== 'function') return 0;

    const put = safeGet(m, 'put');
    const patch = safeGet(m, 'patch');
    const del = safeGet(m, 'del');
    const del2 = safeGet(m, 'delete');
    const base = safeGet(m, 'getAPIBaseURL');

    if (
      typeof put !== 'function' &&
      typeof patch !== 'function' &&
      typeof del !== 'function' &&
      typeof del2 !== 'function' &&
      typeof base !== 'function'
    ) {
      return 0;
    }

    let score = 1;
    if (typeof base === 'function') score += 10;
    if (typeof del === 'function' || typeof del2 === 'function') score += 5;
    if (typeof put === 'function') score += 3;
    if (typeof patch === 'function') score += 2;
    return score;
  }

  function findByExportKey(req, exportKey, methodName) {
    for (const id in req.c) {
      const exp = req.c[id] && req.c[id].exports;
      if (!exp) continue;

      let candidate;
      try { candidate = exp[exportKey]; } catch (_) { continue; }

      if (candidate && typeof safeGet(candidate, methodName) === 'function') {
        return candidate;
      }
    }
    return null;
  }

  // Igual ao gist: método no protótipo do export (evita proxies que devolvem
  // uma função para qualquer chave, como o Messages/intl do Discord).
  function findByProtoExportKey(req, exportKey, methodName) {
    for (const id in req.c) {
      const exp = req.c[id] && req.c[id].exports;
      if (!exp) continue;

      let candidate;
      try { candidate = exp[exportKey]; } catch (_) { continue; }
      if (!candidate) continue;

      let proto;
      try { proto = Object.getPrototypeOf(candidate); } catch (_) { continue; }

      if (proto && typeof safeGet(proto, methodName) === 'function') {
        return candidate;
      }
    }
    return null;
  }

  function patchMethod(obj, name, fn) {
    if (!obj) return false;

    try { obj[name] = fn; } catch (_) {}

    if (obj[name] !== fn) {
      try {
        Object.defineProperty(obj, name, {
          configurable: true,
          enumerable: false,
          writable: true,
          value: fn,
        });
      } catch (_) {}
    }

    return obj[name] === fn;
  }

  let api = null;
  let QuestsStore = null;
  let FluxDispatcher = null;
  let RunningGameStore = null;
  let ApplicationStreamingStore = null;
  let ChannelStore = null;
  let GuildChannelStore = null;

  let diag = {
    webpack: false,
    modules: 0,
    api: false,
    quests: false,
    dispatcher: false,
    runningGames: false,
    streaming: false,
    sources: {},
    samples: [],
  };

  function collectSamples(req) {
    const samples = [];
    if (!req) return samples;

    let scanned = 0;

    for (const id in req.c) {
      if (scanned++ > 5000) break;

      const exp = req.c[id] && req.c[id].exports;
      if (!exp || (typeof exp !== 'object' && typeof exp !== 'function')) continue;

      let keys;
      try { keys = Object.keys(exp); } catch (_) { continue; }
      if (!keys.length) continue;

      const interesting = keys.some((key) => {
        let value;
        try { value = exp[key]; } catch (_) { return false; }
        if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;

        return (
          typeof safeGet(value, 'getQuest') === 'function' ||
          typeof safeGet(value, 'getQuests') === 'function' ||
          typeof safeGet(value, 'dispatch') === 'function' ||
          typeof safeGet(value, 'getAPIBaseURL') === 'function' ||
          typeof safeGet(value, 'flushWaitQueue') === 'function' ||
          (value.quests && typeof value.quests === 'object')
        );
      });

      if (interesting && samples.length < 10) {
        samples.push({ id: String(id), keys: keys.slice(0, 14).join(',') });
      }
    }

    return samples;
  }

  function resolveModules(req) {
    diag = {
      webpack: !!req,
      modules: 0,
      api: false,
      quests: false,
      dispatcher: false,
      runningGames: false,
      streaming: false,
      sources: {},
      samples: [],
    };

    if (req) {
      for (const _id in req.c) diag.modules++;
    } else {
      return false;
    }

    function pick(exportKey, methodName, fallbackPredicate, label, proto) {
      const exact = proto
        ? findByProtoExportKey(req, exportKey, methodName)
        : findByExportKey(req, exportKey, methodName);

      if (exact) {
        diag.sources[label] = (proto ? 'proto exports.' : 'exports.') + exportKey;
        return exact;
      }

      const generic = fallbackPredicate ? findModule(req, fallbackPredicate) : null;
      if (generic) diag.sources[label] = 'scan';

      return generic;
    }

    QuestsStore = pick(
      'A',
      'getQuest',
      (m) => m && m.quests && typeof m.quests === 'object' && typeof safeGet(m, 'getQuest') === 'function',
      'quests',
      true
    );

    FluxDispatcher = pick(
      'h',
      'flushWaitQueue',
      (m) => m && typeof safeGet(m, 'dispatch') === 'function' && typeof safeGet(m, 'flushWaitQueue') === 'function',
      'dispatcher',
      true
    );

    RunningGameStore = pick(
      'Ay',
      'getRunningGames',
      (m) => m && typeof safeGet(m, 'getRunningGames') === 'function' && typeof safeGet(m, 'getGameForPID') === 'function',
      'runningGames',
      false
    );

    ApplicationStreamingStore = pick(
      'A',
      'getStreamerActiveStreamMetadata',
      (m) => m && typeof safeGet(m, 'getStreamerActiveStreamMetadata') === 'function',
      'streaming',
      true
    );

    api = findByExportKey(req, 'Bo', 'get');
    if (api) {
      diag.sources.api = 'exports.Bo';
    } else {
      let bestApi = null;
      let bestScore = 0;
      for (const value of moduleValues(req)) {
        const score = looksLikeApi(value);
        if (score > bestScore) {
          bestScore = score;
          bestApi = value;
        }
      }
      api = bestApi;
      if (api) diag.sources.api = 'scan';
    }

    ChannelStore = findModule(req, (m) => typeof safeGet(m, 'getSortedPrivateChannels') === 'function');
    GuildChannelStore = findModule(req, (m) => typeof safeGet(m, 'getAllGuilds') === 'function');

    diag.api = !!api;
    diag.quests = !!QuestsStore;
    diag.dispatcher = !!FluxDispatcher;
    diag.runningGames = !!RunningGameStore;
    diag.streaming = !!ApplicationStreamingStore;

    const ok = !!(api && QuestsStore && FluxDispatcher);
    if (!ok) diag.samples = collectSamples(req);

    log('módulos:', {
      webpack: diag.webpack,
      modules: diag.modules,
      api: diag.api,
      QuestsStore: diag.quests,
      FluxDispatcher: diag.dispatcher,
      RunningGameStore: diag.runningGames,
      ApplicationStreamingStore: diag.streaming,
      origens: diag.sources,
    });

    return ok;
  }

  // ---------------------------------------------------------------- quest helpers

  function questUser(quest) {
    return quest.userStatus || quest.user_status || {};
  }

  function questConfig(quest) {
    return quest.config || {};
  }

  function parseMaybeJson(value) {
    if (typeof value !== 'string') return value;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function questTaskConfig(quest) {
    const cfg = questConfig(quest);
    const candidates = [
      cfg.taskConfigV2,
      cfg.task_config_v2,
      cfg.taskConfig,
      cfg.task_config,
    ];

    // Configs novas trazem `taskConfig` vazio (legado) junto do `taskConfigV2`
    // preenchido. Um `||` simples para no objeto vazio e esconde as tarefas.
    for (const candidate of candidates) {
      const value = parseMaybeJson(candidate);
      if (value && value.tasks && Object.keys(value.tasks).length) return value;
    }

    for (const candidate of candidates) {
      const value = parseMaybeJson(candidate);
      if (value && typeof value === 'object') return value;
    }

    return {};
  }

  function questTasks(quest) {
    const config = questTaskConfig(quest);
    const tasks = parseMaybeJson(config.tasks);
    return tasks && typeof tasks === 'object' ? tasks : {};
  }

  function questTaskName(quest) {
    const tasks = questTasks(quest);
    const known = TASK_PRIORITY.find((type) => tasks[type] != null);
    if (known) return known;

    // Deixa o switch tratar o tipo real e devolver uma mensagem útil.
    const keys = Object.keys(tasks);
    return keys.length ? keys[0] : null;
  }

  function questTaskTypes(quest) {
    return Object.keys(questTasks(quest));
  }

  function questName(quest) {
    const cfg = questConfig(quest);
    return (
      (cfg.messages && (cfg.messages.questName || cfg.messages.quest_name)) ||
      cfg.questName ||
      String(quest.id)
    );
  }

  function questProgress(quest, taskName) {
    const user = questUser(quest);
    const cfg = questConfig(quest);

    if (cfg.configVersion === 1) {
      return user.streamProgressSeconds || 0;
    }

    const progress = user.progress || {};
    const value = progress[taskName];

    if (typeof value === 'number') return value;
    if (value && typeof value.value === 'number') return value.value;

    if (String(taskName || '').startsWith('WATCH_VIDEO')) {
      const a = progress.WATCH_VIDEO && progress.WATCH_VIDEO.value;
      const b = progress.WATCH_VIDEO_ON_MOBILE && progress.WATCH_VIDEO_ON_MOBILE.value;
      const values = [a, b].filter((n) => typeof n === 'number');
      if (values.length) return Math.max(...values);
    }

    return 0;
  }

  function questEnrolled(quest) {
    const user = questUser(quest);
    return !!(user.enrolledAt || user.enrolled_at);
  }

  function questLocationCandidates(quest) {
    const cfg = questConfig(quest);
    const raw = quest.targeted_content || quest.targetedContent || cfg.targetedContent || cfg.questContent || cfg.quest_content;

    const list = [];

    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (Number.isInteger(item)) list.push(item);
        else if (typeof item === 'string' && QUEST_CONTENT_TYPES[item.toUpperCase()] != null) {
          list.push(QUEST_CONTENT_TYPES[item.toUpperCase()]);
        }
      }
    } else if (Number.isInteger(raw)) {
      list.push(raw);
    } else if (typeof raw === 'string' && QUEST_CONTENT_TYPES[raw.toUpperCase()] != null) {
      list.push(QUEST_CONTENT_TYPES[raw.toUpperCase()]);
    }

    const preferred = [
      QUEST_CONTENT_TYPES.QUEST_HOME_DESKTOP,
      QUEST_CONTENT_TYPES.QUEST_BAR_V2,
      QUEST_CONTENT_TYPES.QUEST_BAR,
      QUEST_CONTENT_TYPES.ACTIVITY_PANEL,
    ];

    const out = [];
    for (const value of preferred) if (list.includes(value) && !out.includes(value)) out.push(value);
    for (const value of list) if (!out.includes(value)) out.push(value);
    if (!out.length) out.push(QUEST_CONTENT_TYPES.QUEST_HOME_DESKTOP);

    return out;
  }

  function questCompleted(quest) {
    const user = questUser(quest);
    return !!(user.completedAt || user.completed_at);
  }

  function questClaimed(quest) {
    const user = questUser(quest);
    return !!(user.claimedAt || user.claimed_at);
  }

  function taskTarget(quest, taskName) {
    const tasks = questTasks(quest);
    const task = tasks[taskName];
    const target = task && task.target;
    if (!Number.isFinite(target) || target <= 0) {
      throw new Error('Alvo de progresso inválido para ' + taskName + '.');
    }
    return target;
  }

  function questExpired(quest) {
    const cfg = questConfig(quest);
    const expires = cfg.expiresAt || cfg.expires_at || quest.expiresAt || quest.expires_at;
    return expires ? new Date(expires).getTime() < Date.now() : false;
  }

  function normalizeQuest(quest) {
    if (!quest) return quest;
    const cfg = quest.config || {};
    return Object.assign({}, quest, {
      userStatus: quest.userStatus || quest.user_status,
      config: Object.assign({}, cfg, {
        taskConfig: cfg.taskConfig || cfg.task_config,
        taskConfigV2: cfg.taskConfigV2 || cfg.task_config_v2,
        expiresAt: cfg.expiresAt || cfg.expires_at,
      }),
    });
  }

  let apiQuests = [];

  function readQuests() {
    const list = [];

    try {
      if (QuestsStore && QuestsStore.quests) {
        const store = QuestsStore.quests;
        if (typeof store.values === 'function') list.push(...store.values());
        else if (Array.isArray(store)) list.push(...store);
        else list.push(...Object.values(store));
      }
    } catch (_) {}

    try {
      if (!list.length && QuestsStore && typeof QuestsStore.getQuests === 'function') {
        const result = QuestsStore.getQuests();
        if (Array.isArray(result)) list.push(...result);
        else if (result && typeof result.values === 'function') list.push(...result.values());
        else if (result && typeof result === 'object') list.push(...Object.values(result));
      }
    } catch (_) {}

    const normalized = list.filter(Boolean).map(normalizeQuest);
    if (normalized.length) return normalized;
    return apiQuests;
  }

  function extractQuestList(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.quests)) return data.quests;

    if (data.body) {
      if (Array.isArray(data.body)) return data.body;
      if (Array.isArray(data.body.quests)) return data.body.quests;
    }

    if (data.data) {
      if (Array.isArray(data.data)) return data.data;
      if (Array.isArray(data.data.quests)) return data.data.quests;
    }

    return [];
  }

  async function fetchQuestsFromApi() {
    if (!api) return [];

    try {
      const res = await api.get({ url: '/quests/@me' });
      const list = extractQuestList(res);
      apiQuests = list.filter(Boolean).map(normalizeQuest);
      log('quests via API:', apiQuests.length);
    } catch (error) {
      log('falha ao buscar /quests/@me', error);
      apiQuests = [];
    }

    return apiQuests;
  }

  async function refreshQuestStore() {
    try {
      if (FluxDispatcher) FluxDispatcher.dispatch({ type: 'QUESTS_FETCH_CURRENT_QUESTS' });
    } catch (_) {}
    await sleep(900);
  }

  // ---------------------------------------------------------------- api actions

  async function enroll(quest) {
    const locations = questLocationCandidates(quest);
    let lastError = null;

    for (const location of locations) {
      try {
        const res = await api.post({
          url: '/quests/' + quest.id + '/enroll',
          body: { location },
        });
        log('enroll ok', { quest: quest.id, location });
        return !!(res && (res.status === 200 || res.ok || res.body));
      } catch (error) {
        lastError = error;
        const body = error && error.body;
        log('enroll falhou', {
          quest: quest.id,
          location,
          erro: body || (error && error.message) || String(error),
        });

        // 50035 = erro de validação; vale tentar outro placement.
        if (!body || body.code !== 50035) break;
      }
    }

    throw lastError || new Error('Falha ao aceitar a missão.');
  }

  async function completeVideo(quest, taskName, onProgress) {
    const needed = taskTarget(quest, taskName);
    let done = questProgress(quest, taskName);

    const speed = 7;
    let completed = false;

    while (true) {
      const remaining = Math.min(speed, needed - done);
      await sleep(remaining * 1000);

      const timestamp = done + speed;
      const res = await api.post({
        url: '/quests/' + quest.id + '/video-progress',
        body: { timestamp: Math.min(needed, timestamp + Math.random()) },
      });

      const body = res && (res.body !== undefined ? res.body : res);
      completed = !!(body && body.completed_at != null);
      done = Math.min(needed, timestamp);
      if (onProgress) onProgress(done, needed);

      if (timestamp >= needed) break;
    }

    if (!completed) {
      await api.post({
        url: '/quests/' + quest.id + '/video-progress',
        body: { timestamp: needed },
      });
    }

    return true;
  }

  async function completePlayDesktop(quest, taskName, onProgress) {
    if (typeof DiscordNative === 'undefined') {
      throw new Error('Missões de jogo só funcionam no app desktop do Discord.');
    }
    if (!RunningGameStore) throw new Error('RunningGameStore não encontrado.');

    const cfg = questConfig(quest);
    const tasks = questTasks(quest);
    const needed = taskTarget(quest, taskName);

    const applicationId =
      (cfg.application && cfg.application.id) ||
      (tasks[taskName].applications && tasks[taskName].applications[0] && tasks[taskName].applications[0].id) ||
      quest.id;

    let appName = (cfg.application && cfg.application.name) || questName(quest);
    let exeName = String(appName).replace(/[\/\\:*?"<>|]/g, '') + '.exe';

    if (api) {
      try {
        const appRes = await api.get({ url: '/applications/public?application_ids=' + applicationId });
        const raw = appRes && (appRes.body !== undefined ? appRes.body : (appRes.data !== undefined ? appRes.data : appRes));
        const appData = Array.isArray(raw)
          ? raw[0]
          : (raw && Array.isArray(raw.applications) ? raw.applications[0] : raw);

        if (appData && typeof appData === 'object' && appData.name) {
          appName = appData.name;
          const winExe = (appData.executables || []).find((x) => x.os === 'win32');
          if (winExe && winExe.name) {
            exeName = String(winExe.name).replace('>', '');
          } else {
            exeName = String(appName).replace(/[\/\\:*?"<>|]/g, '') + '.exe';
          }
        } else {
          log('app público sem dados; usando fallback do config da quest');
        }
      } catch (error) {
        log('falha em /applications/public; usando fallback do config', error);
      }
    }

    const pid = Math.floor(Math.random() * 30000) + 1000;

    const fakeGame = {
      cmdLine: 'C:\\Program Files\\' + appName + '\\' + exeName,
      exeName,
      exePath: 'c:/program files/' + String(appName).toLowerCase() + '/' + exeName,
      hidden: false,
      isLauncher: false,
      id: applicationId,
      name: appName,
      pid,
      pidPath: [pid],
      processName: appName,
      start: Date.now(),
    };

    let realGames = [];
    try {
      const current = RunningGameStore.getRunningGames();
      if (Array.isArray(current)) realGames = current;
    } catch (_) {}

    const realGetRunningGames = RunningGameStore.getRunningGames;
    const realGetGameForPID = RunningGameStore.getGameForPID;

    const patchedGames = patchMethod(RunningGameStore, 'getRunningGames', () => [fakeGame]);
    const patchedPid = patchMethod(RunningGameStore, 'getGameForPID', (value) => (value === pid ? fakeGame : undefined));

    log('spoof de jogo:', {
      app: appName,
      id: applicationId,
      fonte: diag.sources.runningGames,
      patch: patchedGames && patchedPid,
    });

    if (!patchedGames) log('não consegui sobrescrever getRunningGames');

    try {
      FluxDispatcher.dispatch({
        type: 'RUNNING_GAMES_CHANGE',
        removed: realGames,
        added: [fakeGame],
        games: [fakeGame],
      });
    } catch (error) {
      log('dispatcher rejeitou RUNNING_GAMES_CHANGE', error);
    }

    try {
      await new Promise((resolve, reject) => {
        let timer = null;
        let firstBeat = null;

        const cleanup = () => {
          clearTimeout(timer);
          clearTimeout(firstBeat);
          try { FluxDispatcher.unsubscribe('QUESTS_SEND_HEARTBEAT_SUCCESS', onBeat); } catch (_) {}
        };

        const onBeat = (data) => {
          try {
            clearTimeout(firstBeat);
            firstBeat = null;

            const user = data.userStatus || data.user_status || {};
            let progress = 0;
            if (cfg.configVersion === 1) {
              progress = user.streamProgressSeconds || 0;
            } else if (user.progress && user.progress[taskName]) {
              const value = user.progress[taskName];
              progress = typeof value === 'number' ? value : Math.floor(value.value || 0);
            }

            if (onProgress) onProgress(progress, needed);

            if (progress >= needed) {
              cleanup();
              resolve();
            }
          } catch (_) {}
        };

        firstBeat = setTimeout(() => {
          cleanup();
          reject(new Error('O Discord não enviou heartbeat do jogo em 3 minutos. O spoof não foi reconhecido.'));
        }, 3 * 60 * 1000);

        timer = setTimeout(() => {
          cleanup();
          reject(new Error('Tempo esgotado esperando o heartbeat de progresso.'));
        }, 2 * 60 * 60 * 1000);

        FluxDispatcher.subscribe('QUESTS_SEND_HEARTBEAT_SUCCESS', onBeat);
      });
    } finally {
      patchMethod(RunningGameStore, 'getRunningGames', realGetRunningGames);
      patchMethod(RunningGameStore, 'getGameForPID', realGetGameForPID);

      try {
        FluxDispatcher.dispatch({ type: 'RUNNING_GAMES_CHANGE', removed: [fakeGame], added: [], games: [] });
      } catch (error) {
        log('dispatcher rejeitou a limpeza de RUNNING_GAMES_CHANGE', error);
      }
    }

    return true;
  }

  async function completeStream(quest, taskName, onProgress) {
    if (typeof DiscordNative === 'undefined') {
      throw new Error('Missões de transmissão só funcionam no app desktop do Discord.');
    }
    if (!ApplicationStreamingStore) throw new Error('ApplicationStreamingStore não encontrado.');

    const cfg = questConfig(quest);
    const tasks = questTasks(quest);
    const needed = taskTarget(quest, taskName);
    const applicationId = (cfg.application && cfg.application.id) || (tasks[taskName].applications && tasks[taskName].applications[0] && tasks[taskName].applications[0].id);
    const pid = Math.floor(Math.random() * 30000) + 1000;

    const real = ApplicationStreamingStore.getStreamerActiveStreamMetadata;
    patchMethod(ApplicationStreamingStore, 'getStreamerActiveStreamMetadata', () => ({
      id: applicationId,
      pid,
      sourceName: null,
    }));

    try {
      await new Promise((resolve, reject) => {
        let timer = null;

        const cleanup = () => {
          clearTimeout(timer);
          try { FluxDispatcher.unsubscribe('QUESTS_SEND_HEARTBEAT_SUCCESS', onBeat); } catch (_) {}
        };

        const onBeat = (data) => {
          try {
            const user = data.userStatus || data.user_status || {};
            let progress = 0;
            if (cfg.configVersion === 1) {
              progress = user.streamProgressSeconds || 0;
            } else if (user.progress && user.progress[taskName]) {
              const value = user.progress[taskName];
              progress = typeof value === 'number' ? value : Math.floor(value.value || 0);
            }

            if (onProgress) onProgress(progress, needed);

            if (progress >= needed) {
              cleanup();
              resolve();
            }
          } catch (_) {}
        };

        timer = setTimeout(() => {
          cleanup();
          reject(new Error('Tempo esgotado esperando o heartbeat de progresso.'));
        }, 2 * 60 * 60 * 1000);

        FluxDispatcher.subscribe('QUESTS_SEND_HEARTBEAT_SUCCESS', onBeat);
      });
    } finally {
      patchMethod(ApplicationStreamingStore, 'getStreamerActiveStreamMetadata', real);
    }

    return true;
  }

  async function completeActivity(quest, taskName, onProgress) {
    const needed = taskTarget(quest, taskName);

    let channelId = null;

    try {
      const privates = ChannelStore && ChannelStore.getSortedPrivateChannels();
      if (privates && privates[0]) channelId = privates[0].id;
    } catch (_) {}

    if (!channelId && GuildChannelStore) {
      try {
        const guilds = Object.values(GuildChannelStore.getAllGuilds() || {});
        for (const guild of guilds) {
          if (guild && guild.VOCAL && guild.VOCAL.length) {
            channelId = guild.VOCAL[0].channel.id;
            break;
          }
        }
      } catch (_) {}
    }

    if (!channelId) {
      throw new Error('Precisa de um canal de voz (ou DM) para simular a atividade.');
    }

    const streamKey = 'call:' + channelId + ':1';

    while (true) {
      const res = await api.post({
        url: '/quests/' + quest.id + '/heartbeat',
        body: { stream_key: streamKey, terminal: false },
      });

      const progress =
        (res && res.body && res.body.progress && res.body.progress.PLAY_ACTIVITY && res.body.progress.PLAY_ACTIVITY.value) || 0;

      if (onProgress) onProgress(progress, needed);

      if (progress >= needed) {
        await api.post({
          url: '/quests/' + quest.id + '/heartbeat',
          body: { stream_key: streamKey, terminal: true },
        });
        break;
      }

      await sleep(20000);
    }

    return true;
  }

  // ---------------------------------------------------------------- conquistas

  function apiBody(res) {
    if (res && res.body !== undefined) return res.body;
    return res;
  }

  async function relayPost(target, headers, body) {
    const relay = window.__GHOSTQUEST_RELAY__;

    if (!relay || !relay.url || !relay.key) {
      throw new Error('Relay local indisponível. Reinstale o plugin (inject.js) e reinicie o Discord.');
    }

    const res = await fetch(relay.url + '/gq-' + relay.key + '/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: target, headers, body }),
    });

    if (!res.ok) throw new Error('Relay local respondeu HTTP ' + res.status + '.');

    const data = await res.json();

    if (!data || data.ok !== true) {
      const status = data && data.status;
      const payload = data && data.body;
      const detail = payload && (payload.message || payload.error || payload.code);
      const error = new Error('discordsays HTTP ' + (status || '?') + (detail ? ': ' + detail : ''));
      error.status = status;
      error.body = payload;
      throw error;
    }

    return data.body;
  }

  async function waitQuestCompletion(id, timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(3000);

      try {
        const res = await api.get({ url: '/quests/@me' });
        const fresh = extractQuestList(res).map(normalizeQuest)
          .find((item) => String(item.id) === String(id));
        if (fresh && (questCompleted(fresh) || questClaimed(fresh))) return true;
      } catch (_) {}

      try {
        if (QuestsStore && typeof QuestsStore.getQuest === 'function') {
          const raw = QuestsStore.getQuest(id);
          const fresh = raw && normalizeQuest(raw);
          if (fresh && (questCompleted(fresh) || questClaimed(fresh))) return true;
        }
      } catch (_) {}
    }

    return false;
  }

  async function revokeAppToken(appId) {
    try {
      const res = await api.get({ url: '/oauth2/tokens' });
      const body = apiBody(res);
      const list = Array.isArray(body) ? body : (body && Array.isArray(body.tokens) ? body.tokens : []);
      const remove = api.del || api.delete;

      for (const token of list) {
        const id = token && (token.id || token.token_id);
        const app = token && token.application && token.application.id;
        if (!id || String(app) !== String(appId)) continue;
        if (typeof remove === 'function') {
          await remove.call(api, { url: '/oauth2/tokens/' + id });
        }
      }
    } catch (_) {}
  }

  async function completeAchievement(quest, taskName, onProgress) {
    if (!api) throw new Error('Módulo HTTP do Discord não encontrado.');

    const cfg = questConfig(quest);
    const tasks = questTasks(quest);
    const task = tasks[taskName] || {};
    let needed = 0;

    try {
      needed = taskTarget(quest, taskName);
    } catch (_) {
      needed = Number(task.target) > 0 ? Number(task.target) : 1;
    }

    const appId = String(
      (cfg.application && cfg.application.id) ||
      (task.applications && task.applications[0] && task.applications[0].id) ||
      ''
    );
    const appName = (cfg.application && cfg.application.name) || questName(quest);

    if (!/^\d{5,25}$/.test(appId)) {
      throw new Error('Quest sem application id — não dá para abrir o backend de conquista.');
    }

    log('conquista: iniciando', { quest: quest.id, tarefa: taskName, app: appId, alvo: needed });

    const scope = encodeURIComponent('identify applications.commands applications.entitlements');
    const authorizeUrl =
      '/oauth2/authorize?response_type=code&client_id=' + appId +
      '&scope=' + scope + '&state=';

    let authCode = null;

    try {
      const res = await api.post({
        url: authorizeUrl,
        body: {
          permissions: '0',
          authorize: true,
          integration_type: 1,
          location_context: {
            guild_id: '10000',
            channel_id: '10000',
            channel_type: 10000,
          },
        },
      });

      const body = apiBody(res) || {};
      const headers = (res && res.headers) || {};
      const location =
        body.location ||
        body.redirect_uri ||
        (res && res.location) ||
        headers.location ||
        headers.Location ||
        '';
      const match = String(location).match(/[?&]code=([^&]+)/);
      if (match) {
        authCode = decodeURIComponent(match[1]);
      } else {
        log('conquista: authorize sem code', { status: res && res.status, body });
      }
    } catch (error) {
      throw new Error('OAuth do app ' + appName + ' falhou: ' + (error.message || error));
    }

    if (!authCode) {
      throw new Error('O Discord não devolveu o código OAuth do app ' + appName + '.');
    }

    try {
      let ticket = null;

      try {
        const res = await api.post({
          url: '/applications/' + appId + '/proxy-tickets',
          body: {},
        });
        const body = apiBody(res) || {};
        ticket = body.ticket || null;
      } catch (error) {
        throw new Error('proxy-ticket falhou: ' + (error.message || error));
      }

      if (!ticket) throw new Error('O Discord não devolveu proxy ticket para ' + appName + '.');

      log('conquista: proxy ticket ok', { app: appId });

      const base = 'https://' + appId + '.discordsays.com';
      const referer =
        base + '/?instance_id=ghostquest&platform=desktop&discord_proxy_ticket=' +
        encodeURIComponent(ticket);

      let authData;

      try {
        authData = await relayPost(
          base + '/.proxy/acf/authorize',
          {
            'Content-Type': 'application/json',
            'X-Auth-Token': '',
            'X-Discord-Quest-ID': quest.id,
            'Referer': referer,
          },
          { code: authCode }
        );
      } catch (error) {
        if (error.status === 404) {
          throw new Error(
            'O app ' + appName + ' não expõe o backend de conquistas do Discord (404 em /.proxy/acf/authorize).'
          );
        }
        throw error;
      }

      const appToken = authData && (authData.token || authData.access_token);

      if (!appToken) {
        throw new Error('O backend de ' + appName + ' não devolveu token de atividade.');
      }

      log('conquista: authorize ok', { app: appId });

      let progressData;

      try {
        progressData = await relayPost(
          base + '/.proxy/acf/quest/progress',
          {
            'Content-Type': 'application/json',
            'X-Auth-Token': appToken,
            'X-Discord-Quest-ID': quest.id,
            'Referer': referer,
          },
          { progress: needed }
        );
      } catch (error) {
        if (error.status === 404) {
          throw new Error('O backend de ' + appName + ' não tem a rota de progresso da quest (404).');
        }
        throw error;
      }

      if (onProgress) onProgress(needed, needed);

      log('conquista: progresso enviado', {
        app: appId,
        alvo: needed,
        resposta: progressData && typeof progressData === 'object'
          ? Object.keys(progressData).slice(0, 6)
          : String(progressData).slice(0, 80),
      });

      const completed = await waitQuestCompletion(quest.id, 45000);

      log('conquista: verificação', { quest: quest.id, concluida: completed });

      if (!completed) {
        throw new Error(
          'O app ' + appName + ' aceitou o progresso, mas o Discord não marcou a missão como concluída. ' +
          'Pode ser atraso — confira a aba Missões. Resposta: ' +
          JSON.stringify(progressData).slice(0, 160)
        );
      }
    } finally {
      await revokeAppToken(appId);
    }

    return true;
  }

  async function completeQuest(quest, onProgress) {
    if (!api) throw new Error('Módulo HTTP do Discord não encontrado.');
    if (questClaimed(quest) || questCompleted(quest)) return true;

    let current = quest;

    if (!questEnrolled(current)) {
      await enroll(current);
      await sleep(1500);

      if (QuestsStore && typeof QuestsStore.getQuest === 'function') {
        const fresh = QuestsStore.getQuest(current.id);
        if (fresh) current = normalizeQuest(fresh);
      }
    }

    const taskName = questTaskName(current);
    if (!taskName) throw new Error('Tipo de missão não suportado.');
    if (questCompleted(current)) return true;

    switch (taskName) {
      case 'WATCH_VIDEO':
      case 'WATCH_VIDEO_ON_MOBILE':
        return completeVideo(current, taskName, onProgress);
      case 'PLAY_ON_DESKTOP':
      case 'PLAY_ON_DESKTOP_V2':
        return completePlayDesktop(current, taskName, onProgress);
      case 'STREAM_ON_DESKTOP':
        return completeStream(current, taskName, onProgress);
      case 'PLAY_ACTIVITY':
        return completeActivity(current, taskName, onProgress);
      case 'ACHIEVEMENT_IN_ACTIVITY':
        return completeAchievement(current, taskName, onProgress);
      case 'ACHIEVEMENT_IN_GAME':
        throw new Error(
          'Conquista in-game é reportada pelo servidor do próprio jogo (Play Quest+), não pelo cliente do Discord. ' +
          'Não existe caminho local — só jogando de verdade.'
        );
      case 'PLAY_ON_XBOX':
      case 'PLAY_ON_PLAYSTATION':
        throw new Error('Missão de console (' + taskName + '): precisa ser feita no console vinculado à conta.');
      default:
        throw new Error(
          'Tipo de missão não suportado: ' + taskName +
          ' | tarefas da quest: ' + (questTaskTypes(current).join(', ') || '(nenhuma)')
        );
    }
  }

  // ---------------------------------------------------------------- state

  const state = Object.create(null);
  const running = new Set();

  function questState(id) {
    if (!state[id]) {
      state[id] = { status: 'idle', progress: 0, target: 0, msg: '' };
    }
    return state[id];
  }

  // ---------------------------------------------------------------- UI

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value == null ? '' : value);
    return div.innerHTML;
  }

  function ensureStyles() {
    if (document.getElementById('gq-style')) return;

    const style = document.createElement('style');
    style.id = 'gq-style';
    style.textContent = [
      '#gq-fab{position:fixed;right:18px;bottom:18px;z-index:2147483600;width:52px;height:52px;border-radius:14px;border:none;background:linear-gradient(180deg,#5865f2,#4752c4) center/cover no-repeat;color:#fff;font:800 17px/1 "gg sans",Segoe UI,sans-serif;cursor:pointer;box-shadow:0 12px 32px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;transition:filter .15s,transform .15s}',
      '#gq-fab:hover{filter:brightness(1.12);transform:translateY(-1px)}',
      '#gq-fab img{width:100%;height:100%;border-radius:inherit;display:block;pointer-events:none}',
      '#gq-panel{position:fixed;right:18px;bottom:82px;z-index:2147483601;width:390px;max-height:76vh;display:none;flex-direction:column;background-color:#000;background-image:linear-gradient(rgba(255,255,255,.09) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.09) 1px,transparent 1px);background-size:22px 22px;border:1px solid rgba(255,255,255,.12);border-radius:18px;color:#fff;font-family:"GhostQuest Quicksand","gg sans",Segoe UI,sans-serif;box-shadow:0 26px 64px rgba(0,0,0,.65);overflow:hidden}',
      '#gq-panel.gq-open{display:flex}',
      '.gq-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0}',
      '.gq-brand{display:flex;align-items:center;gap:10px;min-width:0}',
      '.gq-logo{width:32px;height:32px;border-radius:9px;background:linear-gradient(180deg,#5865f2,#4752c4) center/cover no-repeat;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:13px;flex-shrink:0;overflow:hidden}',
      '.gq-title{font-weight:800;font-size:15px;letter-spacing:-.01em;line-height:1.1}',
      '.gq-sub{font-size:10px;opacity:.55;margin-top:2px}',
      '.gq-actions{display:flex;gap:6px;flex-shrink:0}',
      '.gq-icon{width:30px;height:30px;border-radius:9px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#fff;cursor:pointer;font-family:inherit;font-size:15px;line-height:1;display:flex;align-items:center;justify-content:center}',
      '.gq-icon:hover{background:rgba(255,255,255,.13)}',
      '.gq-list{padding:12px 14px;overflow-y:auto;display:flex;flex-direction:column;gap:9px;flex:1 1 auto;min-height:80px}',
      '.gq-list::-webkit-scrollbar{width:7px}',
      '.gq-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:8px}',
      '.gq-row{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:10px 11px;animation:gqIn .18s ease}',
      '@keyframes gqIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}',
      '.gq-row-top{display:flex;justify-content:space-between;gap:8px;align-items:baseline}',
      '.gq-name{font-weight:700;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gq-status{font-size:10px;opacity:.6;flex-shrink:0;text-transform:lowercase}',
      '.gq-bar{height:6px;border-radius:99px;background:rgba(255,255,255,.1);margin:8px 0 6px;overflow:hidden}',
      '.gq-fill{height:100%;background-color:#68CC8A;background-image:none;border-radius:99px;transition:width .3s ease}',
      '.gq-row-bot{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.gq-prog{font-size:10.5px;opacity:.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gq-btn{border:none;border-radius:8px;background:#fff;color:#000;font-family:inherit;font-weight:800;font-size:11px;padding:6px 12px;cursor:pointer;flex-shrink:0}',
      '.gq-btn:hover:not(:disabled){filter:brightness(.93)}',
      '.gq-btn:disabled{opacity:.45;cursor:default}',
      '.gq-empty{padding:24px 8px;text-align:center;font-size:12px;opacity:.55;line-height:1.55}',
      '.gq-foot{padding:12px 14px;border-top:1px solid rgba(255,255,255,.08);display:flex;flex-direction:column;gap:8px;flex-shrink:0}',
      '.gq-primary{width:100%;padding:11px;border-radius:11px;border:none;background:linear-gradient(180deg,#fff,#e2e2e2);color:#000;font-family:inherit;font-weight:800;font-size:12.5px;cursor:pointer}',
      '.gq-primary:hover:not(:disabled){filter:brightness(.95)}',
      '.gq-primary:disabled{opacity:.5;cursor:default}',
      '.gq-warn{font-size:9.5px;line-height:1.5;color:#f87171;opacity:.85}',
    ].join('\n');

    document.head.appendChild(style);
  }

  let ui = null;
  let fontPromise = null;

  async function loadFontOnce() {
    const relay = window.__GHOSTQUEST_RELAY__;
    if (!relay || !relay.url || !relay.key) return false;
    if (window.__ghostquestFontLoaded) return true;

    try {
      const res = await fetch(relay.url + '/gq-' + relay.key + '/font');
      if (!res.ok) throw new Error('HTTP ' + res.status);

      const buffer = await res.arrayBuffer();
      const face = new FontFace('GhostQuest Quicksand', buffer);
      await face.load();
      document.fonts.add(face);
      window.__ghostquestFontLoaded = true;
      log('fonte Quicksand carregada');
      return true;
    } catch (error) {
      log('falha ao carregar a fonte Quicksand', error);
      return false;
    }
  }

  function loadFont() {
    if (!fontPromise) fontPromise = loadFontOnce();
    return fontPromise;
  }

  function ensureUI() {
    loadFont();

    if (document.getElementById('gq-fab')) return;

    ensureStyles();

    const fab = document.createElement('button');
    fab.id = 'gq-fab';
    fab.type = 'button';
    fab.title = 'GhostQuest — Missões';
    fab.setAttribute('aria-label', 'GhostQuest — Missões');

    const panel = document.createElement('div');
    panel.id = 'gq-panel';
    panel.innerHTML =
      '<div class="gq-head">' +
        '<div class="gq-brand">' +
          '<div class="gq-logo"></div>' +
          '<div class="gq-title">GhostQuest</div>' +
        '</div>' +
        '<div class="gq-actions">' +
          '<button type="button" class="gq-icon" id="gq-refresh" title="Atualizar">↻</button>' +
          '<button type="button" class="gq-icon" id="gq-close" title="Fechar">×</button>' +
        '</div>' +
      '</div>' +
      '<div class="gq-list" id="gq-list">' +
        '<div class="gq-empty">Carregando…</div>' +
      '</div>' +
      '<div class="gq-foot">' +
        '<button type="button" class="gq-primary" id="gq-all">Completar todas</button>' +
        '<div class="gq-warn">Automação de quests viola o ToS do Discord. Desde ago/2026 contas flagradas estão sendo suspensas do acesso a quests. Use por sua conta e risco.</div>' +
      '</div>';

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    const icon = window.__GHOSTQUEST_ICON__;
    if (icon) {
      fab.style.backgroundImage = 'url("' + icon + '")';
      const logo = panel.querySelector('.gq-logo');
      if (logo) logo.style.backgroundImage = 'url("' + icon + '")';
    }

    ui = { fab, panel };

    fab.onclick = (event) => {
      if (event) { event.preventDefault(); event.stopPropagation(); }
      panel.classList.toggle('gq-open');
      if (panel.classList.contains('gq-open')) render();
    };

    panel.querySelector('#gq-close').onclick = () => panel.classList.remove('gq-open');
    panel.querySelector('#gq-refresh').onclick = () => refresh();
    panel.querySelector('#gq-all').onclick = () => completeAll();
  }

  function render() {
    const list = document.getElementById('gq-list');
    if (!list) return;

    const quests = readQuests()
      .filter((quest) => quest && quest.id != null && !questExpired(quest))
      .sort((a, b) => Number(questCompleted(a)) - Number(questCompleted(b)));

    if (!quests.length) {
      const all = document.getElementById('gq-all');
      if (all) all.style.display = 'none';
      list.innerHTML = '<div class="gq-empty">Nenhuma missão encontrada.<br>Abra Descobrir → Missões no Discord e clique ↻.</div>';
      return;
    }

    const allButton = document.getElementById('gq-all');
    if (allButton) allButton.style.display = '';

    list.innerHTML = '';

    for (const quest of quests) {
      const id = String(quest.id);
      const current = questState(id);
      const taskName = questTaskName(quest);
      const tasks = questTasks(quest);
      const target = taskName && tasks[taskName] ? tasks[taskName].target : 0;
      const progress = questProgress(quest, taskName);
      const done = questCompleted(quest) || questClaimed(quest) || current.status === 'done';
      const isRunning = running.has(id);

      const percent = target
        ? Math.min(100, Math.round((progress / target) * 100))
        : done ? 100 : 0;

      const statusText = done
        ? (questClaimed(quest) ? 'resgatada' : 'concluída')
        : isRunning
          ? 'rodando'
          : current.status === 'error'
            ? 'erro'
            : (TASK_LABELS[taskName] || taskName || '—');

      const row = document.createElement('div');
      row.className = 'gq-row';
      row.innerHTML =
        '<div class="gq-row-top">' +
          '<div class="gq-name">' + escapeHtml(questName(quest)) + '</div>' +
          '<div class="gq-status">' + escapeHtml(statusText) + '</div>' +
        '</div>' +
        '<div class="gq-bar"><div class="gq-fill" style="width:' + percent + '%"></div></div>' +
        '<div class="gq-row-bot">' +
          '<div class="gq-prog">' +
            Math.floor(progress) + ' / ' + (target || '?') +
            (current.msg ? ' · ' + escapeHtml(current.msg) : '') +
          '</div>' +
          (done
            ? ''
            : '<button type="button" class="gq-btn" data-id="' + id + '"' + (isRunning ? ' disabled' : '') + '>' +
                (isRunning ? '…' : 'Completar') +
              '</button>') +
        '</div>';

      list.appendChild(row);
    }

    list.querySelectorAll('.gq-btn').forEach((button) => {
      button.onclick = () => startQuest(button.getAttribute('data-id'));
    });
  }

  async function startQuest(id) {
    if (running.has(id)) return;
    if (questState(String(id)).status === 'done') return;

    const quest = readQuests().find((item) => String(item.id) === String(id));
    if (!quest) return;

    const current = questState(id);
    const taskName = questTaskName(quest);
    const target = taskName && questTasks(quest)[taskName] ? questTasks(quest)[taskName].target : 0;

    current.status = 'running';
    current.progress = questProgress(quest, taskName);
    current.target = target;
    current.msg = '';

    running.add(id);
    render();

    try {
      await completeQuest(quest, (progress, total) => {
        current.progress = progress;
        current.target = total;
        render();
      });

      current.status = 'done';
      current.msg = 'concluída';
      log('quest concluída:', questName(quest));
    } catch (error) {
      current.status = 'error';
      current.msg = String(error && error.message ? error.message : error);
      log('erro na quest:', questName(quest), error);
    } finally {
      running.delete(id);
      render();
    }
  }

  async function completeAll() {
    const button = document.getElementById('gq-all');
    if (button) button.disabled = true;

    const quests = readQuests().filter((quest) =>
      quest &&
      quest.id != null &&
      !questExpired(quest) &&
      !questCompleted(quest) &&
      !questClaimed(quest) &&
      questState(String(quest.id)).status !== 'done' &&
      questTaskName(quest)
    );

    for (const quest of quests) {
      if (!running.has(String(quest.id))) {
        await startQuest(quest.id);
      }
    }

    if (button) button.disabled = false;
  }

  async function refresh() {
    ensureUI();

    const list = document.getElementById('gq-list');
    if (list) list.innerHTML = '<div class="gq-empty">Atualizando…</div>';

    if (!api || !QuestsStore) {
      const req = await waitForWebpack().catch(() => null);
      if (req) resolveModules(req);
    }

    if (!QuestsStore) {
      if (list) {
        const summary =
          'webpack: ' + (diag.webpack ? 'ok' : 'não') +
          ' | módulos: ' + diag.modules +
          '\napi: ' + (diag.api ? 'ok' : 'não') +
          ' | QuestsStore: ' + (diag.quests ? 'ok' : 'não') +
          ' | dispatcher: ' + (diag.dispatcher ? 'ok' : 'não') +
          ' | runningGames: ' + (diag.runningGames ? 'ok' : 'não') +
          ' | streaming: ' + (diag.streaming ? 'ok' : 'não') +
          '\n\namostras:\n' + (diag.samples.length ? diag.samples.map((s) => s.id + ' -> ' + s.keys).join('\n') : '(nenhuma)');

        list.innerHTML =
          '<div class="gq-empty">' +
            'Não encontrei os módulos internos do Discord.<br><br>' +
            '<pre id="gq-diag" style="text-align:left;white-space:pre-wrap;word-break:break-word;font-size:9.5px;opacity:.7;margin:0 0 10px;max-height:180px;overflow:auto;background:rgba(0,0,0,.32);padding:8px;border-radius:8px">' +
              escapeHtml(summary) +
            '</pre>' +
            '<button type="button" class="gq-btn" id="gq-copy-diag">Copiar diagnóstico</button>' +
          '</div>';

        const copy = list.querySelector('#gq-copy-diag');
        if (copy) {
          copy.onclick = async () => {
            try {
              await navigator.clipboard.writeText(summary);
              copy.textContent = 'Copiado!';
            } catch (_) {
              copy.textContent = 'Falhou';
            }
          };
        }
      }
      return;
    }

    await refreshQuestStore();

    if (!readQuests().length && api) {
      await fetchQuestsFromApi();
    }

    render();
  }

  // ---------------------------------------------------------------- boot

  async function boot() {
    if (!document.body) {
      await new Promise((resolve) => {
        const check = () => (document.body ? resolve() : setTimeout(check, 200));
        check();
      });
    }

    const req = await waitForWebpack().catch((error) => {
      log(error);
      return null;
    });

    if (req) resolveModules(req);

    ensureUI();
    await refresh();
  }

  window.__ghostquestUI = true;
  boot();
})();
