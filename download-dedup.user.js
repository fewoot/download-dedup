// ==UserScript==
// @name         下载站重复点击提醒
// @namespace    local.download-dedup
// @version      1.1.0
// @description  在下载站记住你点过的资源标题；标题前后被加字也能认出来，末尾数字/括号会当作集数区分。
// @author       download-dedup contributors
// @license      MIT
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
     一、用户配置
     ------------------------------------------------------------
     1. 站点启用方式（二选一）：
        A. 在下面 hostSuffixes 里写域名，例如 'example.com'。
           它会匹配 example.com 和所有子域名。
        B. 安装后打开目标网站，点 Tampermonkey 图标 ->
           “启用‘下载去重提醒’于本站”。
     2. 如果某个站的标题链接识别不到，把它的标题链接 CSS 选择器
        加到 titleSelectors 里。
     ============================================================ */

  const SITE_RULES = {
    // 域名后缀：写 'example.com' 会匹配 example.com、www.example.com、m.example.com
    hostSuffixes: [
      // 'example.com',
      // 'example.net',
    ],

    // URL 前缀：只在这些地址开头的页面启用（适合只启用某个板块）
    urlPrefixes: [
      // 'https://www.example.com/forum/',
    ],

    // 可选：站点标题链接的 CSS 选择器。填了会优先按它识别。
    titleSelectors: [
      // 'a.thread-title',
      // 'h3 a[href*="/thread-"]',
    ],

    // 可选：排除某些链接
    excludeSelectors: [
      // '.sidebar a',
    ],
  };

  const CONFIG = {
    // 短于这个长度的核心标题，只做“完全相同”匹配，不做模糊匹配
    minFuzzyCoreLength: 6,
    // 模糊匹配阈值，越高越保守
    fuzzyThreshold: 0.82,
    // 每条记录最多保存多少个标题变体 / 链接
    maxAliases: 24,
    maxUrls: 24,
    // 同一个链接在多少毫秒内只记一次，防止站点重复触发 click
    clickDedupeMs: 1200,
    // 点击次数达到多少才显示徽标
    showBadgeForCount: 1,
    // false：尽量识别所有像标题的链接；true：只识别分数较高的标题链接
    strictTitleDetection: false,
    debug: false,
  };

  const STORE_KEY = 'dldedup.db.v1';
  const UI_ATTR = 'data-dldedup-ui';
  const BADGE_ATTR = 'data-dldedup-badge';

  /* ============================================================
     二、通用工具
     ============================================================ */

  const GM_AVAILABLE =
    typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

  let storageErrorNotified = false;

  function storageGet(key, fallback) {
    try {
      if (GM_AVAILABLE) {
        const value = GM_getValue(key, fallback);
        return value === undefined ? fallback : value;
      }
      if (typeof localStorage !== 'undefined') {
        const value = localStorage.getItem(key);
        return value === null ? fallback : value;
      }
    } catch (error) {
      console.warn('[下载去重] 读取存储失败', error);
    }
    return fallback;
  }

  function storageSet(key, value) {
    if (GM_AVAILABLE) {
      GM_setValue(key, value);
      return true;
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
      return true;
    }
    return false;
  }

  function normalizeHost(host) {
    return String(host || '')
      .toLowerCase()
      .replace(/^www\./, '');
  }

  function hostMatches(host, rule) {
    let value = String(rule || '').trim().toLowerCase();
    if (!value) return false;
    if (/^https?:\/\//i.test(value)) {
      try {
        value = new URL(value).hostname;
      } catch (error) {
        return false;
      }
    }
    value = value
      .replace(/^\*\./, '')
      .replace(/^www\./, '')
      .replace(/^\.+/, '');
    return host === value || host.endsWith('.' + value);
  }

  function uniquePush(list, value) {
    if (value && !list.includes(value)) list.push(value);
  }

  function pad2(number) {
    return String(number).padStart(2, '0');
  }

  function fullTime(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '未知';
    return (
      date.getFullYear() +
      '-' +
      pad2(date.getMonth() + 1) +
      '-' +
      pad2(date.getDate()) +
      ' ' +
      pad2(date.getHours()) +
      ':' +
      pad2(date.getMinutes())
    );
  }

  function shortTime(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    if (sameDay) {
      return '今天 ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday =
      date.getFullYear() === yesterday.getFullYear() &&
      date.getMonth() === yesterday.getMonth() &&
      date.getDate() === yesterday.getDate();
    if (isYesterday) {
      return '昨天 ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    }
    if (date.getFullYear() === now.getFullYear()) {
      return (
        pad2(date.getMonth() + 1) +
        '-' +
        pad2(date.getDate()) +
        ' ' +
        pad2(date.getHours()) +
        ':' +
        pad2(date.getMinutes())
      );
    }
    return (
      date.getFullYear() +
      '-' +
      pad2(date.getMonth() + 1) +
      '-' +
      pad2(date.getDate())
    );
  }

  function dateStamp() {
    const date = new Date();
    return (
      date.getFullYear() +
      pad2(date.getMonth() + 1) +
      pad2(date.getDate()) +
      '-' +
      pad2(date.getHours()) +
      pad2(date.getMinutes())
    );
  }

  function genId() {
    return (
      'r' +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8)
    );
  }

  function countCoreChars(text) {
    const matches = String(text || '').match(/[\p{L}\p{N}]/gu);
    return matches ? matches.length : 0;
  }

  function hasCJK(text) {
    return /[\u3400-\u9fff]/.test(String(text || ''));
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function makeButton(text, className, onClick) {
    const button = el('button', className || '', text);
    button.type = 'button';
    if (onClick) button.addEventListener('click', onClick);
    return button;
  }

  /* ============================================================
     三、存储与数据模型
     ============================================================ */

  let db = defaultDB();
  let recordsBySig = new Map();
  let matchCache = new Map();
  const analysisCache = new Map();
  let currentHost = '';
  let initialized = false;

  function defaultDB() {
    return {
      version: 1,
      updatedAt: 0,
      settings: {
        enabledSites: [],
        disabledSites: [],
      },
      records: [],
    };
  }

  function normalizeDB(input) {
    const result = defaultDB();
    if (!input || typeof input !== 'object') return result;

    result.updatedAt = Number(input.updatedAt) || 0;

    if (input.settings && typeof input.settings === 'object') {
      if (Array.isArray(input.settings.enabledSites)) {
        result.settings.enabledSites = Array.from(
          new Set(
            input.settings.enabledSites
              .filter((item) => typeof item === 'string')
              .map(normalizeHost)
              .filter(Boolean)
          )
        );
      }
      if (Array.isArray(input.settings.disabledSites)) {
        result.settings.disabledSites = Array.from(
          new Set(
            input.settings.disabledSites
              .filter((item) => typeof item === 'string')
              .map(normalizeHost)
              .filter(Boolean)
          )
        );
      }
    }

    const rawRecords = Array.isArray(input.records) ? input.records : [];
    const records = [];

    for (const item of rawRecords) {
      if (!item || typeof item !== 'object') continue;

      const core = typeof item.core === 'string' ? item.core : '';
      let cores = Array.isArray(item.cores)
        ? item.cores.filter((value) => typeof value === 'string' && value)
        : [];
      if (core && !cores.includes(core)) cores.unshift(core);
      cores = Array.from(new Set(cores)).slice(0, 8);
      if (!cores.length) continue;

      let markers = Array.isArray(item.markers)
        ? item.markers.filter((value) => typeof value === 'string' && value)
        : [];
      markers = Array.from(new Set(markers)).sort();

      let markerSig =
        typeof item.markerSig === 'string' ? item.markerSig : markers.join('|');
      if (markers.length) markerSig = markers.join('|');

      const now = Number(item.lastAt) || Number(item.firstAt) || Date.now();
      const title = typeof item.title === 'string' ? item.title : cores[0];
      const urls = Array.isArray(item.urls)
        ? item.urls.filter((value) => typeof value === 'string' && value)
        : [];
      const sites = Array.isArray(item.sites)
        ? item.sites.filter((value) => typeof value === 'string' && value)
        : [];

      const aliases = Array.isArray(item.aliases)
        ? item.aliases
            .filter(
              (alias) =>
                alias &&
                typeof alias === 'object' &&
                typeof alias.title === 'string'
            )
            .map((alias) => ({
              title: alias.title,
              url: typeof alias.url === 'string' ? alias.url : '',
              at: Number(alias.at) || now,
            }))
        : [];

      records.push({
        id: typeof item.id === 'string' && item.id ? item.id : genId(),
        core: cores[0],
        cores,
        markers,
        markerSig,
        title,
        count: Math.max(1, Number(item.count) || 1),
        firstAt: Number(item.firstAt) || now,
        lastAt: now,
        lastTitle:
          typeof item.lastTitle === 'string' ? item.lastTitle : title,
        lastUrl: typeof item.lastUrl === 'string' ? item.lastUrl : urls[0] || '',
        urls: Array.from(new Set(urls)).slice(-CONFIG.maxUrls),
        sites: Array.from(new Set(sites)),
        aliases: aliases.slice(-CONFIG.maxAliases),
      });
    }

    result.records = records;
    return result;
  }

  function loadDB() {
    const raw = storageGet(STORE_KEY, '');
    if (!raw) return defaultDB();
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return normalizeDB(parsed);
    } catch (error) {
      console.warn('[下载去重] 数据库解析失败，已使用空数据', error);
      return defaultDB();
    }
  }

  function persist(refresh) {
    db.updatedAt = Date.now();
    let ok = false;
    try {
      ok = storageSet(STORE_KEY, JSON.stringify(db));
    } catch (error) {
      console.warn('[下载去重] 保存失败', error);
    }
    if (!ok && !storageErrorNotified) {
      storageErrorNotified = true;
      console.warn(
        '[下载去重] 无法写入脚本存储，请检查 Tampermonkey 的存储权限或站点存储限制。'
      );
    }
    rebuildIndex();
    clearMatchCache();
    if (refresh !== false) scheduleScan(80);
  }

  function rebuildIndex() {
    recordsBySig = new Map();
    for (const record of db.records) {
      const list = recordsBySig.get(record.markerSig) || [];
      list.push(record);
      recordsBySig.set(record.markerSig, list);
    }
    for (const list of recordsBySig.values()) {
      list.sort((a, b) => b.lastAt - a.lastAt);
    }
  }

  function clearMatchCache() {
    matchCache.clear();
  }

  function isSiteEnabled() {
    const host = normalizeHost(location.hostname);
    if (db.settings.disabledSites.includes(host)) return false;

    if (SITE_RULES.hostSuffixes.some((rule) => hostMatches(host, rule))) {
      return true;
    }
    if (
      SITE_RULES.urlPrefixes.some((prefix) => {
        const href = String(location.href);
        return href.startsWith(prefix) || (href + '/').startsWith(prefix);
      })
    ) {
      return true;
    }
    return db.settings.enabledSites.includes(host);
  }

  /* ============================================================
     四、标题清洗与集数标记
     ============================================================ */

  const CN_DIGITS = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };

  const CN_UNITS = {
    十: 10,
    百: 100,
    千: 1000,
  };

  const RESOLUTIONS = new Set([
    240, 360, 480, 540, 576, 720, 1080, 1440, 2160, 4320,
  ]);

  const RE_SIZE = /\b\d+(?:\.\d+)?\s*(?:TB|GB|MB|KB|T|G|M|K)\b/gi;

  const RE_FORMAT =
    /\b(?:MP4|MKV|AVI|RMVB|MOV|FLV|WMV|M2TS|TS|ISO|RAR|ZIP|7Z|PDF|EPUB|MOBI|TXT|EXE|APK|DMG|TORRENT)(?:\s*版)?(?=$|[\s\-_/|·—])/gi;

  const RE_TECH =
    /\b(?:4K|8K|UHD|HD|HDR|DV|H\.?264|H\.?265|HEVC|AVC|x264|x265|AAC|DTS|AC3|FLAC|WEB[- ]?DL|BluRay|BDRip|HDRip|REMUX|10bit|8bit|1080P|720P|2160P|1440P|480P|360P)\b/gi;

  const RE_DOMAIN =
    /\b(?:www\.)?[a-z0-9][a-z0-9-]{0,62}\.(?:com|net|org|cn|cc|tv|me|io|xyz|top|vip|club|site|info|co|la|ws|biz|us|uk|jp|kr)\b/gi;

  const SEMANTIC_EXTRA_RE =
    /(?:第\s*[0-9零〇一二三四五六七八九十百两]+|(?:^|[^a-z])(?:s\d+|ep?\d+|season|part|vol|volume|chapter|episode)\b|剧场版|前传|后传|外传|特别篇|特别版|番外|真人版|动画版|电影版|最终季|最终版|新篇|续篇|完结篇|合集|全集|套装|系列|导演剪辑版|导演版|加长版|未删减|无删减|重制版|修复版|修正版|完整版|珍藏版|收藏版|入门|精通|进阶|基础|高级|实战|教程|指南|技巧|方法|案例|项目|课程|新版|旧版|最新版|修订版|双语版|国语版|粤语版|英语版|日语版|韩语版|篇|章|(?:\b(?:new|old|best|full|final|complete|special|extra|season|part|vol|episode|movie|series|remaster(?:ed)?|uncut|extended|director'?s?)\b))/i;

  const DECOR_SUFFIX_RE =
    /(?:整理|发布|分享|资源|下载|网盘|字幕|翻译|压制|制作|工作室|论坛|社区|网站|首发|独家|更多|更新|修复|补档|高清|超清|蓝光|中字|双语|国语|粤语|英语|日语|韩语|HD|UHD|HDR|by|www|版|\.(?:com|net|org|cn|cc|tv|me|io|xyz|top|vip|club|site|info)\b)/i;

  const BRACKET_NOISE_RE =
    /(?:字幕|字幕组|汉化|翻译|压制|制作|发布|整理|资源|分享|下载|网盘|论坛|社区|网站|工作室|首发|独家|更多|最新|免费|高清|超清|蓝光|中字|双语|国语|粤语|英语|日语|韩语|MP4|MKV|HD|UHD|HDR|解压密码|提取码|@|www|\.(?:com|net|org|cn|cc|tv|me|io|xyz|top|vip|club|site))/i;

  const SEMANTIC_TAG_RE =
    /(?:剧场版|前传|后传|外传|特别篇|特别版|番外|真人版|动画版|电影版|最终季|最终章|新篇|续篇|完结篇|合集|全集|套装|系列|导演|加长|未删减|无删减|重制|修复|修正|完整版|珍藏版|收藏版|入门|精通|进阶|基础|高级|实战|教程|指南|技巧|方法|案例|项目|课程|新版|旧版|修订版|篇|章)/i;

  const NOISE_SEG_RE =
    /(?:下载|资源|分享|发布|整理|论坛|网站|社区|网盘|字幕|汉化|压制|制作|工作室|字幕组|首发|独家|更多|最新|免费|高清|蓝光|4K|HDR|MP4|MKV|电影|影视|吧|站|组|社|@|www|\.(?:com|net|org|cn|cc|tv|me|io|xyz|top|vip|club|site))/i;

  const EDGE_NOISE =
    '(?:高清版|超清版|蓝光版|HD版|中字版|MP4版|高清|超清|蓝光|4K|8K|UHD|HDR|HD|中字|字幕|双语|国语|粤语|英语|日语|韩语|翻译|中外文|WEB[- ]?DL|BluRay|HDTV|BDRip|HDRip|REMUX)';

  const RE_EDGE_NOISE_LEAD = new RegExp(
    '^[\\s\\-_|·—/]*' + EDGE_NOISE + '(?=$|[\\s\\-_|·—/])[\\s\\-_|·—/]*',
    'i'
  );
  const RE_EDGE_NOISE_TAIL = new RegExp(
    '[\\s\\-_|·—/]*' + EDGE_NOISE + '(?=$|[\\s\\-_|·—/])[\\s\\-_|·—/]*$',
    'i'
  );

  function cnNumToInt(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/^\d+$/.test(text)) return String(parseInt(text, 10));

    // “二〇二四”这种年份写法，直接按位拼
    if (/^[零〇一二三四五六七八九]+$/.test(text) && text.length > 1) {
      return text
        .split('')
        .map((char) => String(CN_DIGITS[char]))
        .join('')
        .replace(/^0+(?=\d)/, '');
    }

    let total = 0;
    let section = 0;
    let number = 0;

    for (const char of text) {
      if (Object.prototype.hasOwnProperty.call(CN_DIGITS, char)) {
        number = CN_DIGITS[char];
      } else if (Object.prototype.hasOwnProperty.call(CN_UNITS, char)) {
        const unit = CN_UNITS[char];
        if (number === 0) number = 1;
        section += number * unit;
        number = 0;
      } else if (char === '万') {
        section = (section + number) * 10000;
        total += section;
        section = 0;
        number = 0;
      } else {
        return '';
      }
    }

    const totalNumber = total + section + number;
    return String(totalNumber);
  }

  function addNumericMarker(value, add) {
    const normalized = cnNumToInt(value);
    if (normalized === '') return false;
    const number = parseInt(normalized, 10);
    if (!Number.isFinite(number)) return false;

    if (RESOLUTIONS.has(number)) return true;
    if (number >= 1900 && number <= 2099) {
      add('year', String(number));
    } else {
      add('ep', String(number));
    }
    return true;
  }

  function stripBracketDecor(input) {
    let text = String(input || '').trim();
    const leadRe = /^\s*[\(\[【（]\s*([^\)\]】）]{0,60}?)\s*[\)\]】）]\s*/;
    const tailRe = /\s*[\(\[【（]\s*([^\)\]】）]{0,60}?)\s*[\)\]】）]\s*$/;

    for (let index = 0; index < 4; index += 1) {
      let changed = false;

      const lead = text.match(leadRe);
      if (
        lead &&
        shouldStripBracket(lead[1], text.slice(lead[0].length), 'lead')
      ) {
        text = text.slice(lead[0].length);
        changed = true;
      }

      const tail = text.match(tailRe);
      if (tail && shouldStripBracket(tail[1], text.slice(0, tail.index), 'tail')) {
        text = text.slice(0, tail.index);
        changed = true;
      }

      if (!changed) break;
    }

    return text.trim();
  }

  function shouldStripBracket(content, rest, edge) {
    const text = String(content || '').trim();
    if (!text) return true;

    const compact = text
      .replace(RE_SIZE, ' ')
      .replace(RE_FORMAT, ' ')
      .replace(RE_TECH, ' ')
      .replace(/[^\p{L}\p{N}]/gu, '');

    if (!compact) return true;
    if (SEMANTIC_TAG_RE.test(compact)) return false;
    if (BRACKET_NOISE_RE.test(compact)) return true;

    // 前缀括号可能是真正标题的一部分（如【鬼灭之刃】无限列车篇），
    // 不随便删；让后面的模糊匹配去处理上传者前缀。
    if (edge === 'lead') return false;

    // 后缀括号更常见的是上传者/站点标记，保留真正有语义的标签。
    if (countCoreChars(rest) >= 4) return true;
    if (compact.length <= 6 && countCoreChars(rest) >= 2) return true;
    return false;
  }

  function shouldStripSegment(segment, rest, leading) {
    const text = String(segment || '').trim();
    const restText = String(rest || '').trim();
    if (!text || text.length > 16) return false;
    if (countCoreChars(restText) < 2) return false;
    if (NOISE_SEG_RE.test(text)) return true;
    if (SEMANTIC_EXTRA_RE.test(text)) return false;
    if (/\d/.test(text)) return false;

    if (hasCJK(text) && text.length <= 8) return true;

    // 英文标题里的连字符（如 Spider-Man）不当作装饰
    return false;
  }

  function stripSeparatorSegments(input) {
    let text = String(input || '').trim();

    for (let index = 0; index < 3; index += 1) {
      let changed = false;

      const lead = text.match(/^(.{1,16}?)\s*[-–—_|·]\s*(.+)$/u);
      if (lead) {
        const segment = lead[1].trim();
        const rest = lead[2].trim();
        if (shouldStripSegment(segment, rest, true)) {
          text = rest;
          changed = true;
        }
      }

      const tail = text.match(/^(.+?)\s*[-–—_|·]\s*(.{1,16})$/u);
      if (tail) {
        const rest = tail[1].trim();
        const segment = tail[2].trim();
        if (shouldStripSegment(segment, rest, false)) {
          text = rest;
          changed = true;
        }
      }

      if (!changed) break;
    }

    return text.trim();
  }

  function stripEdgeNoise(input) {
    let text = String(input || '').trim();
    for (let index = 0; index < 3; index += 1) {
      const before = text;
      text = text.replace(RE_EDGE_NOISE_LEAD, '').replace(RE_EDGE_NOISE_TAIL, '');
      if (before === text) break;
    }
    return text.trim();
  }

  function analyzeTitle(rawTitle) {
    const original = String(rawTitle || '')
      .normalize('NFKC')
      .replace(/[\u200b-\u200d\ufeff]/g, ' ')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!original) return null;

    let text = original;
    const markers = new Set();
    const add = (type, value) => {
      if (value === '' || value === undefined || value === null) return;
      markers.add(type + ':' + String(value));
    };

    // 链接、邮箱、密码一般都不是标题内容
    text = text
      .replace(/https?:\/\/[^\s]+/gi, ' ')
      .replace(/\bwww\.[^\s]+/gi, ' ')
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, ' ')
      .replace(
        /(?:解压密码|提取码|访问密码|密码)\s*[:：]?\s*[A-Za-z0-9_-]{2,24}/gi,
        ' '
      );

    // 日期先按区分标记处理，避免把每天一集的内容混在一起
    text = text.replace(
      /\b((?:19|20)\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?!\d)/g,
      (match, year, month, day) => {
        add('date', year + pad2(parseInt(month, 10)) + pad2(parseInt(day, 10)));
        return ' ';
      }
    );

    // “更新至12集”是进度，不作为集数标记；更新后的同一页面仍然算同一个资源
    text = text.replace(
      /(?:更新|连载|连載)至\s*(?:第\s*)?([0-9零〇一二三四五六七八九十百两]+)\s*(?:集|话|話|期|回)/g,
      ' '
    );

    // “全12集”“12集全”是合集包
    text = text.replace(
      /(?:全|共)\s*([0-9零〇一二三四五六七八九十百两]+)\s*(?:集|话|話|期|回)/g,
      (match, number) => {
        add('pack', cnNumToInt(number));
        return ' ';
      }
    );
    text = text.replace(
      /([0-9零〇一二三四五六七八九十百两]+)\s*(?:集|话|話|期|回)\s*(?:全|完|完结)/g,
      (match, number) => {
        add('pack', cnNumToInt(number));
        return ' ';
      }
    );
    text = text.replace(/(?:全集|合集|套装)/g, () => {
      add('pack', 'all');
      return ' ';
    });

    // 1-12集
    text = text.replace(
      /(?:第\s*)?([0-9零〇一二三四五六七八九十百两]+)\s*[-~—至]\s*([0-9零〇一二三四五六七八九十百两]+)\s*(?:集|话|話|期|回)/g,
      (match, start, end) => {
        const startNumber = cnNumToInt(start);
        const endNumber = cnNumToInt(end);
        if (startNumber !== '' && endNumber !== '') {
          add('range', startNumber + '-' + endNumber);
        }
        return ' ';
      }
    );

    // 第N季、第N卷、第N部、第N章
    text = text.replace(
      /第\s*([0-9零〇一二三四五六七八九十百两]+)\s*季/g,
      (match, number) => {
        add('season', cnNumToInt(number));
        return ' ';
      }
    );
    text = text.replace(
      /第\s*([0-9零〇一二三四五六七八九十百两]+)\s*(?:卷|册)/g,
      (match, number) => {
        add('vol', cnNumToInt(number));
        return ' ';
      }
    );
    text = text.replace(
      /第\s*([0-9零〇一二三四五六七八九十百两]+)\s*部/g,
      (match, number) => {
        add('part', cnNumToInt(number));
        return ' ';
      }
    );
    text = text.replace(
      /第\s*([0-9零〇一二三四五六七八九十百两]+)\s*章/g,
      (match, number) => {
        add('ch', cnNumToInt(number));
        return ' ';
      }
    );

    // S01E02
    text = text.replace(
      /\bS(\d{1,2})\s*[-_.]?\s*E(\d{1,3})\b/gi,
      (match, season, episode) => {
        add('season', parseInt(season, 10));
        add('ep', parseInt(episode, 10));
        return ' ';
      }
    );

    // 第2集、第2话
    text = text.replace(
      /第\s*([0-9零〇一二三四五六七八九十百两]+)\s*(?:集|话|話|期|回)/g,
      (match, number) => {
        add('ep', cnNumToInt(number));
        return ' ';
      }
    );

    // “2集”这种省略“第”的写法
    text = text.replace(
      /(?:^|[\s\-_\[【（(])([0-9零〇一二三四五六七八九十百两]+)\s*(?:集|话|話|期|回)(?=$|[\s\-_\]】）)])/g,
      (match, number) => {
        add('ep', cnNumToInt(number));
        return ' ';
      }
    );

    // EP2 / E02
    text = text.replace(
      /\bEP?\s*(\d{1,4})\b/gi,
      (match, number) => {
        add('ep', parseInt(number, 10));
        return ' ';
      }
    );

    // Season 2 / Vol.2 / Part 2 / Chapter 2
    text = text.replace(
      /\bSeason\s*(\d{1,2})\b/gi,
      (match, number) => {
        add('season', parseInt(number, 10));
        return ' ';
      }
    );
    text = text.replace(
      /\bVol(?:ume)?\.?\s*(\d{1,3})\b/gi,
      (match, number) => {
        add('vol', parseInt(number, 10));
        return ' ';
      }
    );
    text = text.replace(
      /\bPart\.?\s*(\d{1,3})\b/gi,
      (match, number) => {
        add('part', parseInt(number, 10));
        return ' ';
      }
    );
    text = text.replace(
      /\bChapter\s*(\d{1,4})\b/gi,
      (match, number) => {
        add('ch', parseInt(number, 10));
        return ' ';
      }
    );

    // 单独的 S2
    text = text.replace(
      /(?:^|[\s\-_\[【（(])S(\d{1,2})(?=$|[\s\-_\]】）)])/gi,
      (match, number) => {
        add('season', parseInt(number, 10));
        return ' ';
      }
    );

    // 结尾的“第2”
    text = text.replace(
      /(?:^|[\s\-_·|—/])第\s*([0-9零〇一二三四五六七八九十百两]+)\s*$/g,
      (match, number) => {
        add('ep', cnNumToInt(number));
        return ' ';
      }
    );

    // 结尾的纯数字括号：blender教程（2）、blender教程 [02]
    text = text.replace(
      /[\(\[【（]\s*(\d{1,4}|[零〇一二三四五六七八九十百两]{1,6})\s*[\)\]】）]/g,
      (match, number) => {
        addNumericMarker(number, add);
        return ' ';
      }
    );

    // 结尾带分隔符的数字：blender教程 - 2、blender教程 2
    text = text.replace(
      /(^|[\s\-_·|—/])(\d{1,4})\s*$/g,
      (match, lead, number, offset) => {
        const before = text.slice(0, offset);
        if (countCoreChars(before) < 2) return match;
        const value = parseInt(number, 10);
        if (RESOLUTIONS.has(value)) return ' ';
        if (value >= 1900 && value <= 2099) {
          add('year', String(value));
        } else {
          add('ep', String(value));
        }
        return ' ';
      }
    );

    // 紧贴中文的数字：blender教程2、流浪地球2
    text = text.replace(
      /([\u3400-\u9fff])(\d{1,4})\s*$/g,
      (match, lastChar, number, offset) => {
        const before = text.slice(0, offset + 1);
        if (countCoreChars(before) < 3) return match;
        const value = parseInt(number, 10);
        if (RESOLUTIONS.has(value)) return lastChar;
        if (value >= 1900 && value <= 2099) {
          add('year', String(value));
        } else {
          add('ep', String(value));
        }
        return lastChar;
      }
    );

    // 技术信息、分辨率、大小
    text = text
      .replace(RE_SIZE, ' ')
      .replace(RE_FORMAT, ' ')
      .replace(RE_TECH, ' ');

    // 去掉标题前后的上传者标签、格式标签、站点域名等
    text = stripBracketDecor(text);
    text = stripSeparatorSegments(text);
    text = stripEdgeNoise(text);
    text = text.replace(RE_DOMAIN, ' ');

    let core = text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '');

    if (!core) {
      core = original
        .replace(/[\(\[【（][^\)\]】）]*[\)\]】）]/g, ' ')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '');
    }

    if (!core || core.length < 2) return null;
    if (core.length > 160) core = core.slice(0, 160);

    const markerList = Array.from(markers).sort();
    return {
      raw: original,
      core,
      markers: markerList,
      markerSig: markerList.join('|'),
    };
  }

  function analyzeTitleCached(rawTitle) {
    const key = String(rawTitle || '');
    if (analysisCache.has(key)) return analysisCache.get(key);
    const result = analyzeTitle(key);
    if (analysisCache.size > 1200) analysisCache.clear();
    analysisCache.set(key, result);
    return result;
  }

  function markerLabel(marker) {
    const separator = marker.indexOf(':');
    const type = separator >= 0 ? marker.slice(0, separator) : marker;
    const value = separator >= 0 ? marker.slice(separator + 1) : '';

    switch (type) {
      case 'ep':
        return '第' + value + '集';
      case 'season':
        return '第' + value + '季';
      case 'vol':
        return '第' + value + '卷';
      case 'part':
        return '第' + value + '部';
      case 'ch':
        return '第' + value + '章';
      case 'pack':
        return value === 'all' ? '合集/全集' : '共' + value + '集';
      case 'range':
        return value + '集';
      case 'date':
        return value.replace(
          /^(\d{4})(\d{2})(\d{2})$/,
          '$1-$2-$3'
        );
      case 'year':
        return value + '年';
      default:
        return marker;
    }
  }

  function formatMarkers(markers) {
    if (!Array.isArray(markers) || !markers.length) return '';
    return markers.map(markerLabel).join(' · ');
  }

  /* ============================================================
     五、相似度与匹配
     ============================================================ */

  function diceCoefficient(a, b) {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;

    const grams = new Map();
    for (let index = 0; index < a.length - 1; index += 1) {
      const gram = a.slice(index, index + 2);
      grams.set(gram, (grams.get(gram) || 0) + 1);
    }

    let intersection = 0;
    for (let index = 0; index < b.length - 1; index += 1) {
      const gram = b.slice(index, index + 2);
      const count = grams.get(gram) || 0;
      if (count > 0) {
        intersection += 1;
        grams.set(gram, count - 1);
      }
    }

    return (2 * intersection) / (a.length - 1 + (b.length - 1));
  }

  function longestCommonSubstring(a, b) {
    if (!a || !b) return null;
    const previous = new Uint16Array(b.length + 1);
    const current = new Uint16Array(b.length + 1);
    let bestLength = 0;
    let bestA = 0;
    let bestB = 0;

    for (let i = 1; i <= a.length; i += 1) {
      for (let j = 1; j <= b.length; j += 1) {
        if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
          const length = previous[j - 1] + 1;
          current[j] = length;
          if (length > bestLength) {
            bestLength = length;
            bestA = i - length;
            bestB = j - length;
          }
        } else {
          current[j] = 0;
        }
      }
      previous.set(current);
      current.fill(0);
    }

    if (!bestLength) return null;
    return { length: bestLength, startA: bestA, startB: bestB };
  }

  function safePrefixExtra(extra) {
    if (!extra) return false;
    if (extra.length > 8) return false;
    if (/\d/.test(extra)) return false;
    if (SEMANTIC_EXTRA_RE.test(extra)) return false;
    if (/(?:的|之|版|篇|季|集|话|部|章|卷|期)$/.test(extra)) return false;
    if (/'s$/i.test(extra)) return false;
    if (/^[新旧老原全超高大小中日韩英]$/.test(extra)) return false;
    return true;
  }

  function safeSuffixExtra(extra) {
    if (!extra) return false;
    if (extra.length > 12) return false;
    if (/\d/.test(extra)) return false;
    if (SEMANTIC_EXTRA_RE.test(extra)) return false;
    return DECOR_SUFFIX_RE.test(extra);
  }

  function coreSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;

    const minLength = Math.min(a.length, b.length);
    const maxLength = Math.max(a.length, b.length);
    if (minLength < CONFIG.minFuzzyCoreLength) return 0;
    if (minLength / maxLength < 0.55) return 0;

    if (a.includes(b) || b.includes(a)) {
      const shorter = a.length <= b.length ? a : b;
      const longer = a.length <= b.length ? b : a;
      const firstIndex = longer.indexOf(shorter);
      const lastIndex = longer.lastIndexOf(shorter);

      let index = firstIndex;
      if (firstIndex !== lastIndex) {
        const firstAtEdge =
          firstIndex === 0 || firstIndex + shorter.length === longer.length;
        const lastAtEdge =
          lastIndex === 0 || lastIndex + shorter.length === longer.length;
        if (!firstAtEdge && lastAtEdge) index = lastIndex;
        else if (!firstAtEdge && !lastAtEdge) return 0;
      }

      const prefix = longer.slice(0, index);
      const suffix = longer.slice(index + shorter.length);
      const ratio = minLength / maxLength;

      if (prefix && suffix) {
        if (safePrefixExtra(prefix) && safeSuffixExtra(suffix)) {
          return 0.8 + 0.12 * ratio;
        }
        return 0;
      }

      if (prefix) {
        if (safePrefixExtra(prefix)) return 0.86 + 0.12 * ratio;
        if (safeSuffixExtra(prefix)) return 0.82 + 0.1 * ratio;
        return 0;
      }

      if (suffix) {
        if (safeSuffixExtra(suffix)) return 0.84 + 0.12 * ratio;
        return 0;
      }
    }

    // 两个标题各自有不同的前缀，但中间的标题主体相同
    if (minLength / maxLength < 0.65) return 0;
    if (diceCoefficient(a, b) < 0.72) return 0;

    const common = longestCommonSubstring(a, b);
    if (!common || common.length < CONFIG.minFuzzyCoreLength) return 0;

    const prefixA = a.slice(0, common.startA);
    const suffixA = a.slice(common.startA + common.length);
    const prefixB = b.slice(0, common.startB);
    const suffixB = b.slice(common.startB + common.length);
    const coverage = common.length / maxLength;
    if (coverage < 0.8) return 0;

    if (!suffixA && !suffixB && prefixA && prefixB) {
      if (safePrefixExtra(prefixA) && safePrefixExtra(prefixB)) {
        return 0.8 + 0.12 * coverage;
      }
    }

    if (!prefixA && !prefixB && suffixA && suffixB) {
      if (safeSuffixExtra(suffixA) && safeSuffixExtra(suffixB)) {
        return 0.8 + 0.12 * coverage;
      }
    }

    return 0;
  }

  function findMatch(analysis) {
    if (!analysis) return null;

    const cacheKey = analysis.markerSig + '||' + analysis.core;
    if (matchCache.has(cacheKey)) return matchCache.get(cacheKey);

    const candidates = recordsBySig.get(analysis.markerSig) || [];
    let best = null;
    let second = null;

    for (const record of candidates) {
      let score = 0;
      for (const core of record.cores) {
        if (core === analysis.core) {
          score = 1;
          break;
        }
        const similarity = coreSimilarity(core, analysis.core);
        if (similarity > score) score = similarity;
      }
      if (score <= 0) continue;

      if (!best || score > best.score) {
        second = best;
        best = {
          rec: record,
          score,
          kind: score === 1 ? 'exact' : 'fuzzy',
        };
      } else if (!second || score > second.score) {
        second = { rec: record, score };
      }
    }

    let result = null;
    if (best && (best.score === 1 || best.score >= CONFIG.fuzzyThreshold)) {
      if (best.score === 1) {
        result = best;
      } else if (!second || best.score - second.score >= 0.02) {
        result = best;
      }
    }

    matchCache.set(cacheKey, result);
    return result;
  }

  function addAlias(record, title, url, at) {
    const existing = record.aliases.find(
      (alias) => alias.title === title && (alias.url || '') === (url || '')
    );
    if (existing) {
      existing.at = at;
    } else {
      record.aliases.push({ title, url: url || '', at });
      if (record.aliases.length > CONFIG.maxAliases) {
        record.aliases.splice(0, record.aliases.length - CONFIG.maxAliases);
      }
    }
  }

  function addUrl(record, url) {
    if (!url) return;
    if (!record.urls.includes(url)) {
      record.urls.push(url);
      if (record.urls.length > CONFIG.maxUrls) {
        record.urls.splice(0, record.urls.length - CONFIG.maxUrls);
      }
    }
  }

  function addCore(record, core) {
    if (!core) return;
    if (!record.cores.includes(core)) {
      record.cores.push(core);
      if (record.cores.length > 8) {
        record.cores.splice(0, record.cores.length - 8);
      }
    }
  }

  function addSite(record, site) {
    if (site) uniquePush(record.sites, site);
  }

  function createRecord(analysis, title, url, now) {
    return {
      id: genId(),
      core: analysis.core,
      cores: [analysis.core],
      markers: analysis.markers.slice(),
      markerSig: analysis.markerSig,
      title,
      count: 1,
      firstAt: now,
      lastAt: now,
      lastTitle: title,
      lastUrl: url || '',
      urls: url ? [url] : [],
      sites: currentHost ? [currentHost] : [],
      aliases: [{ title, url: url || '', at: now }],
    };
  }

  function bumpRecord(record, analysis, title, url, now) {
    record.count = (Number(record.count) || 0) + 1;
    record.lastAt = now;
    record.lastTitle = title;
    if (url) record.lastUrl = url;
    addSite(record, currentHost);
    addCore(record, analysis.core);
    addAlias(record, title, url, now);
    addUrl(record, url);
  }

  function normalizeUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      url.hash = '';
      const tracking = [];
      for (const key of Array.from(url.searchParams.keys())) {
        if (
          /^(?:utm_.+|spm|ref|referrer|share|shareid|_t|timestamp)$/i.test(key)
        ) {
          tracking.push(key);
        }
      }
      for (const key of tracking) url.searchParams.delete(key);
      url.searchParams.sort();

      let result = url.href;
      if (url.pathname !== '/' && result.endsWith('/')) {
        result = result.slice(0, -1);
      }
      return result;
    } catch (error) {
      return String(rawUrl || '');
    }
  }

  /* ============================================================
     六、页面链接识别
     ============================================================ */

  const UI_TEXT_RE =
    /^(?:下载|立即下载|点击下载|本地下载|网盘下载|迅雷下载|磁力下载|BT下载|种子下载|提取码|解压密码|复制|复制链接|购买|开通|登录|注册|搜索|首页|上一页|下一页|尾页|末页|返回|更多|查看|详情|评论|回复|收藏|分享|举报|编辑|删除|置顶|精华|楼主|查看全部|展开|收起|在线观看|立即播放|免费下载|VIP|教程|帮助|规则|公告|网站地图|联系我们|下载地址|网盘地址|第[0-9零〇一二三四五六七八九十百两]+页)$/i;

  const SIZE_TEXT_RE =
    /^\s*\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB|K|M|G|T)\s*$/i;

  const FILE_EXT_RE =
    /\.(?:zip|rar|7z|tar|gz|torrent|mp4|mkv|avi|rmvb|mov|wmv|flv|mp3|flac|wav|exe|msi|apk|dmg|iso|pdf|epub|mobi|txt|docx?|xlsx?|pptx?)$/i;

  const DETAIL_URL_RE =
    /(?:^|[\/?&=._-])(?:thread|post|detail|resource|view|soft|game|movie|tv|book|article|content|download|down|dl|file|topic|show|info|read|entry|res|pan)(?:[\/?&=._-]|$)/i;

  const TITLE_HINT_RE =
    /(?:title|subject|thread|topic|entry|post|name|res|item|list|article|movie|game|soft|book)/i;

  const candidateCache = new WeakMap();

  function getAnchorTitle(anchor) {
    let title = String(anchor.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!title) {
      const image = anchor.querySelector('img[alt]');
      if (image) title = String(image.getAttribute('alt') || '').trim();
    }
    if (!title) {
      title = String(
        anchor.getAttribute('title') || anchor.getAttribute('aria-label') || ''
      ).trim();
    }

    return title.replace(/\s+/g, ' ').trim();
  }

  function matchesAny(element, selectors) {
    if (!Array.isArray(selectors) || !selectors.length) return false;
    for (const selector of selectors) {
      if (!selector || typeof selector !== 'string') continue;
      try {
        if (element.matches(selector)) return true;
      } catch (error) {
        if (CONFIG.debug) {
          console.warn('[下载去重] 无效选择器：' + selector, error);
        }
      }
    }
    return false;
  }

  function isCandidateTitle(anchor, knownTitle) {
    const title = knownTitle === undefined ? getAnchorTitle(anchor) : knownTitle;
    if (!title) return false;

    const signature = [
      title,
      anchor.href || '',
      anchor.getAttribute('class') || '',
      anchor.id || '',
      anchor.parentElement ? anchor.parentElement.getAttribute('class') || '' : '',
      anchor.parentElement ? anchor.parentElement.id || '' : '',
    ].join('\u0001');

    const cached = candidateCache.get(anchor);
    if (cached && cached.signature === signature) return cached.result;

    const result = evaluateCandidate(anchor, title);
    candidateCache.set(anchor, { signature, result });
    return result;
  }

  function evaluateCandidate(anchor, title) {
    if (!title || title.length < 2 || title.length > 240) return false;
    if (UI_TEXT_RE.test(title)) return false;
    if (SIZE_TEXT_RE.test(title)) return false;
    if (!/[\p{L}\p{N}]/u.test(title)) return false;
    if (anchor.hasAttribute('download')) return false;
    if (anchor.closest('button,label')) return false;

    let url;
    try {
      url = new URL(anchor.getAttribute('href'), location.href);
    } catch (error) {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (FILE_EXT_RE.test(url.pathname)) return false;
    if (
      url.hash &&
      url.origin === location.origin &&
      url.pathname === location.pathname &&
      url.search === location.search
    ) {
      return false;
    }

    const forced = matchesAny(anchor, SITE_RULES.titleSelectors);
    if (matchesAny(anchor, SITE_RULES.excludeSelectors)) return false;

    if (!forced) {
      if (
        anchor.closest(
          'nav,header,footer,[role="navigation"],.pagination,.breadcrumb,.breadcrumbs'
        )
      ) {
        return false;
      }
    }

    if (forced) return true;
    if (!CONFIG.strictTitleDetection) return true;
    if (title.length < 3) return false;

    let score = 0;
    if (anchor.closest('h1,h2,h3,h4,h5,h6')) score += 4;
    if (anchor.querySelector('h1,h2,h3,h4,h5,h6')) score += 4;
    if (
      anchor.closest(
        '[class*="title"],[id*="title"],[class*="subject"],[class*="thread"],[class*="topic"],[itemprop="name"],[itemprop="headline"]'
      )
    ) {
      score += 3;
    }
    if (
      anchor.closest(
        'main,article,[class*="content"],[id*="content"],[class*="main"],[id*="main"],.post,.list,.thread,.forum'
      )
    ) {
      score += 2;
    }

    const context = [
      anchor.getAttribute('class') || '',
      anchor.id || '',
      anchor.parentElement ? anchor.parentElement.getAttribute('class') || '' : '',
      anchor.parentElement ? anchor.parentElement.id || '' : '',
    ]
      .join(' ')
      .toLowerCase();
    if (TITLE_HINT_RE.test(context)) score += 3;
    if (DETAIL_URL_RE.test(url.pathname + url.search)) score += 2;
    if (anchor.querySelector('img')) score += 1;
    if (anchor.closest('li,tr,article,section,dl,dd')) score += 1;
    if (title.length >= 8) score += 1;

    const next = anchor.nextElementSibling;
    if (
      next &&
      /(?:\d+(?:\.\d+)?\s*(?:KB|MB|GB|TB)|20\d{2}[-/.年]|下载|网盘|格式|大小)/i.test(
        String(next.textContent || '').slice(0, 160)
      )
    ) {
      score += 1;
    }

    return score >= 3 || (score >= 2 && title.length >= 12);
  }

  /* ============================================================
     七、徽标、详情弹层、管理面板
     ============================================================ */

  let badgeMap = new WeakMap();
  let overlayHost = null;
  let overlayKeydown = null;

  const BADGE_CSS = `
    :host {
      display: inline-flex !important;
      align-items: center;
      margin: 0 6px 0 0 !important;
      vertical-align: middle !important;
      line-height: 1 !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    .badge {
      all: unset;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 6px;
      border-radius: 999px;
      background: #2563eb;
      color: #fff;
      font-size: 11px;
      line-height: 18px;
      font-weight: 700;
      text-align: center;
      white-space: nowrap;
      cursor: pointer;
      box-shadow: 0 1px 3px rgba(0, 0, 0, .22);
      letter-spacing: 0;
      vertical-align: middle;
    }
    .badge:hover { filter: brightness(1.08); }
    .badge:active { transform: translateY(1px); }
    .badge[data-level="2"] { background: #d97706; }
    .badge[data-level="3"] { background: #dc2626; }
    .badge:focus-visible { outline: 2px solid #93c5fd; outline-offset: 2px; }
  `;

  const SETUP_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .card {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2147483646;
      width: min(330px, calc(100vw - 24px));
      padding: 14px;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      background: #fff;
      color: #111827;
      box-shadow: 0 12px 40px rgba(0, 0, 0, .25);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    .head { display: flex; align-items: flex-start; gap: 8px; }
    .title { flex: 1; font-size: 14px; line-height: 1.4; font-weight: 700; }
    .close {
      border: 0;
      background: transparent;
      color: inherit;
      padding: 0 2px;
      font-size: 20px;
      line-height: 18px;
      cursor: pointer;
      opacity: .55;
    }
    .close:hover { opacity: 1; }
    .text { margin-top: 8px; font-size: 12px; line-height: 1.65; color: #4b5563; }
    .actions { display: flex; gap: 8px; margin-top: 12px; }
    .btn {
      border: 1px solid #d1d5db;
      border-radius: 8px;
      background: #fff;
      color: #111827;
      padding: 7px 11px;
      font-size: 12px;
      line-height: 1.3;
      cursor: pointer;
    }
    .btn:hover { background: #f9fafb; }
    .btn.primary { border-color: #2563eb; background: #2563eb; color: #fff; }
    .btn.primary:hover { background: #1d4ed8; }
    @media (prefers-color-scheme: dark) {
      .card { border-color: #374151; background: #111827; color: #f3f4f6; }
      .text { color: #cbd5e1; }
      .btn { border-color: #4b5563; background: #111827; color: #f3f4f6; }
      .btn:hover { background: #1f2937; }
      .btn.primary { border-color: #2563eb; background: #2563eb; color: #fff; }
      .btn.primary:hover { background: #1d4ed8; }
    }
  `;

  const TOAST_CSS = `
    :host { all: initial; }
    .toast {
      position: fixed;
      left: 50%;
      bottom: 22px;
      z-index: 2147483646;
      transform: translateX(-50%);
      max-width: calc(100vw - 30px);
      padding: 9px 14px;
      border-radius: 999px;
      background: rgba(17, 24, 39, .96);
      color: #fff;
      box-shadow: 0 8px 30px rgba(0, 0, 0, .28);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      font-size: 12px;
      line-height: 1.5;
      text-align: center;
      word-break: break-word;
    }
  `;

  const OVERLAY_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .backdrop {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      background: rgba(15, 23, 42, .58);
      backdrop-filter: blur(2px);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #111827;
    }
    .card {
      width: min(580px, calc(100vw - 32px));
      max-height: calc(100vh - 40px);
      overflow: auto;
      padding: 20px;
      border-radius: 14px;
      background: #fff;
      box-shadow: 0 22px 70px rgba(0, 0, 0, .35);
    }
    .head { display: flex; align-items: flex-start; gap: 12px; }
    .head h2 { flex: 1; margin: 0; font-size: 18px; line-height: 1.4; }
    .icon {
      border: 0;
      background: transparent;
      color: inherit;
      font-size: 24px;
      line-height: 24px;
      padding: 0 2px;
      cursor: pointer;
      opacity: .65;
    }
    .icon:hover { opacity: 1; }
    .subtitle {
      margin-top: 6px;
      font-size: 14px;
      line-height: 1.6;
      color: #4b5563;
      word-break: break-word;
    }
    .meta {
      display: grid;
      gap: 6px;
      margin: 16px 0;
      padding: 12px;
      border-radius: 10px;
      background: #f3f4f6;
      font-size: 13px;
      line-height: 1.5;
    }
    .meta-row { display: flex; gap: 8px; }
    .meta-label { flex: 0 0 44px; color: #6b7280; }
    .meta-value { flex: 1; min-width: 0; word-break: break-word; }
    .section-title {
      margin: 18px 0 8px;
      font-size: 13px;
      color: #6b7280;
      font-weight: 600;
    }
    .alias-list {
      display: grid;
      gap: 8px;
      max-height: 190px;
      overflow: auto;
      padding-right: 4px;
    }
    .alias-item {
      padding: 8px 10px;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      background: #fff;
    }
    .alias-title { font-size: 13px; line-height: 1.5; word-break: break-word; }
    .alias-time { margin-top: 2px; font-size: 11px; color: #9ca3af; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
    .btn {
      border: 1px solid #d1d5db;
      border-radius: 8px;
      background: #fff;
      color: #111827;
      padding: 8px 12px;
      font-size: 13px;
      line-height: 1.3;
      cursor: pointer;
    }
    .btn:hover { background: #f9fafb; }
    .btn.primary { border-color: #2563eb; background: #2563eb; color: #fff; }
    .btn.primary:hover { background: #1d4ed8; }
    .btn.danger { border-color: #fecaca; color: #b91c1c; }
    .btn.danger:hover { background: #fef2f2; }
    .btn.small { padding: 5px 9px; font-size: 12px; }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    .search {
      width: 100%;
      margin: 14px 0 10px;
      padding: 9px 11px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      background: #fff;
      color: inherit;
      font-size: 13px;
      outline: none;
    }
    .search:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, .15); }
    .record-list { display: grid; gap: 8px; max-height: 52vh; overflow: auto; padding-right: 3px; }
    .record-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 10px;
      border: 1px solid #e5e7eb;
      border-radius: 9px;
      background: #fff;
    }
    .record-main { flex: 1; min-width: 0; cursor: pointer; }
    .record-title { font-size: 13px; line-height: 1.5; word-break: break-word; }
    .record-meta { margin-top: 3px; font-size: 11px; color: #6b7280; }
    .record-actions { display: flex; gap: 6px; flex: 0 0 auto; }
    .empty { padding: 30px 0; text-align: center; color: #9ca3af; font-size: 13px; }
    .footer { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    @media (prefers-color-scheme: dark) {
      .backdrop { color: #f3f4f6; }
      .card { background: #111827; }
      .subtitle { color: #cbd5e1; }
      .meta { background: #1f2937; }
      .meta-label { color: #94a3b8; }
      .alias-item, .record-row, .search, .btn { background: #111827; color: #f3f4f6; border-color: #374151; }
      .btn:hover { background: #1f2937; }
      .btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
      .btn.primary:hover { background: #1d4ed8; }
      .btn.danger { color: #fca5a5; border-color: #7f1d1d; }
      .btn.danger:hover { background: #1f2937; }
      .record-title { color: #f3f4f6; }
      .record-meta, .alias-time { color: #94a3b8; }
    }
  `;

  function createBadgeHost() {
    const host = document.createElement('span');
    host.setAttribute(UI_ATTR, 'badge');
    host.setAttribute(BADGE_ATTR, '1');
    host.style.setProperty('display', 'inline-flex', 'important');
    host.style.setProperty('margin-left', '0', 'important');
    host.style.setProperty('margin-right', '6px', 'important');
    host.style.setProperty('vertical-align', 'middle', 'important');
    host.style.setProperty('line-height', '1', 'important');
    host.style.setProperty('font-size', '12px', 'important');

    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = BADGE_CSS;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'badge';
    root.append(style, button);

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (host.__dldedupRecord) openRecord(host.__dldedupRecord);
    });

    host.addEventListener('mousedown', (event) => event.stopPropagation());
    host.addEventListener('click', (event) => event.stopPropagation());

    return host;
  }

  function buildTooltip(record) {
    const lines = [
      '已点击 ' + record.count + ' 次',
      '最近：' + fullTime(record.lastAt),
      '首次：' + fullTime(record.firstAt),
    ];
    if (record.markers.length) {
      lines.push('标记：' + formatMarkers(record.markers));
    }
    if (record.sites.length) {
      lines.push('站点：' + record.sites.join('、'));
    }
    if (record.aliases.length > 1) {
      const titles = record.aliases
        .slice(-3)
        .map((alias) => alias.title)
        .filter(Boolean);
      if (titles.length) lines.push('标题变体：' + titles.join(' ｜ '));
    }
    return lines.join('\n');
  }

  function updateBadgeHost(host, record) {
    host.__dldedupRecord = record;
    host.setAttribute('data-record-id', record.id);

    const button = host.shadowRoot.querySelector('button');
    if (!button) return;
    button.textContent = record.count > 99 ? '99+' : String(record.count);
    button.title = buildTooltip(record);
    button.dataset.level =
      record.count >= 4 ? '3' : record.count >= 2 ? '2' : '1';
    button.dataset.count = String(record.count);
    button.setAttribute(
      'aria-label',
      '已点击 ' + record.count + ' 次，最近 ' + fullTime(record.lastAt) + '，点击查看详情'
    );
  }

  function refreshBadgesForRecord(record) {
    document.querySelectorAll('[' + BADGE_ATTR + ']').forEach((host) => {
      if (host.getAttribute('data-record-id') === record.id) {
        updateBadgeHost(host, record);
      }
    });
  }

  function upsertBadge(anchor, record) {
    let host = badgeMap.get(anchor);
    if (!host || !host.isConnected) {
      host = createBadgeHost();
      anchor.insertAdjacentElement('beforebegin', host);
      if (!host.isConnected) {
        host.remove();
        return;
      }
      badgeMap.set(anchor, host);
    }

    updateBadgeHost(host, record);
  }

  function removeBadge(anchor) {
    const host = badgeMap.get(anchor);
    if (!host) return;
    host.remove();
    badgeMap.delete(anchor);
  }

  function removeAllBadges() {
    document
      .querySelectorAll('[' + BADGE_ATTR + ']')
      .forEach((node) => node.remove());
    // WeakMap 不能清空，重建引用即可；旧节点已经被移除
    badgeMap = new WeakMap();
  }

  function removeBadgesForRecord(recordId) {
    document.querySelectorAll('[' + BADGE_ATTR + ']').forEach((node) => {
      if (node.getAttribute('data-record-id') === recordId) node.remove();
    });
  }

  function createOverlay() {
    closeOverlay();

    const host = document.createElement('div');
    host.setAttribute(UI_ATTR, 'overlay');
    host.style.setProperty('display', 'block', 'important');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('inset', '0', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');

    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    root.append(style, backdrop);

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) closeOverlay();
    });

    overlayKeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeOverlay();
      }
    };
    document.addEventListener('keydown', overlayKeydown, true);

    document.body.appendChild(host);
    overlayHost = host;
    return { host, backdrop };
  }

  function closeOverlay() {
    if (overlayKeydown) {
      document.removeEventListener('keydown', overlayKeydown, true);
      overlayKeydown = null;
    }
    if (overlayHost) {
      overlayHost.remove();
      overlayHost = null;
    }
  }

  function openRecord(record) {
    if (!record) return;
    const { backdrop } = createOverlay();
    const card = el('div', 'card');

    const head = el('div', 'head');
    const heading = el('h2', '', '已点击 ' + record.count + ' 次');
    const close = makeButton('×', 'icon', closeOverlay);
    close.setAttribute('aria-label', '关闭');
    head.append(heading, close);

    const subtitle = el('div', 'subtitle', record.title);

    const meta = el('div', 'meta');
    const addMeta = (label, value) => {
      if (!value) return;
      const row = el('div', 'meta-row');
      row.append(el('span', 'meta-label', label));
      row.append(el('span', 'meta-value', value));
      meta.append(row);
    };
    addMeta('最近', fullTime(record.lastAt));
    addMeta('首次', fullTime(record.firstAt));
    if (record.markers.length) {
      addMeta('标记', formatMarkers(record.markers));
    }
    if (record.sites.length) {
      addMeta('站点', record.sites.join('、'));
    }

    card.append(head, subtitle, meta);

    if (record.aliases.length > 1) {
      card.append(el('div', 'section-title', '标题变体（同一资源的不同写法）'));
      const list = el('div', 'alias-list');
      record.aliases
        .slice()
        .reverse()
        .slice(0, 10)
        .forEach((alias) => {
          const item = el('div', 'alias-item');
          item.append(el('div', 'alias-title', alias.title));
          item.append(el('div', 'alias-time', fullTime(alias.at)));
          list.append(item);
        });
      card.append(list);
    }

    const actions = el('div', 'actions');
    const openButton = makeButton('打开最近链接', 'btn primary', () => {
      if (record.lastUrl) {
        window.open(record.lastUrl, '_blank', 'noopener');
      }
    });
    openButton.disabled = !record.lastUrl;

    const deleteButton = makeButton('删除此记录', 'btn danger', () => {
      if (!window.confirm('确定删除这条记录吗？\n' + record.title)) return;
      db.records = db.records.filter((item) => item.id !== record.id);
      persist();
      removeBadgesForRecord(record.id);
      closeOverlay();
    });

    const closeButton = makeButton('关闭', 'btn', closeOverlay);
    actions.append(openButton, deleteButton, closeButton);
    card.append(actions);

    backdrop.append(card);
  }

  function openManager() {
    closeOverlay();
    const { backdrop } = createOverlay();
    const card = el('div', 'card');

    const head = el('div', 'head');
    const heading = el('h2', '', '已记录资源');
    const close = makeButton('×', 'icon', closeOverlay);
    close.setAttribute('aria-label', '关闭');
    head.append(heading, close);

    const search = el('input', 'search');
    search.type = 'search';
    search.placeholder = '搜索标题 / 变体…';

    const list = el('div', 'record-list');

    const render = () => {
      list.textContent = '';
      const query = search.value.trim().toLowerCase();
      const records = db.records
        .filter((record) => {
          if (!query) return true;
          const haystack = [
            record.title,
            record.lastTitle,
            ...record.aliases.map((alias) => alias.title),
          ]
            .join(' ')
            .toLowerCase();
          return haystack.includes(query);
        })
        .sort((a, b) => b.lastAt - a.lastAt)
        .slice(0, 300);

      if (!records.length) {
        list.append(el('div', 'empty', query ? '没有匹配的记录' : '还没有记录'));
        return;
      }

      for (const record of records) {
        const row = el('div', 'record-row');
        const main = el('div', 'record-main');
        main.append(el('div', 'record-title', record.title));
        main.append(
          el(
            'div',
            'record-meta',
            '已看' +
              record.count +
              '次 · ' +
              shortTime(record.lastAt) +
              (record.markers.length
                ? ' · ' + formatMarkers(record.markers)
                : '')
          )
        );
        main.addEventListener('click', () => openRecord(record));

        const actions = el('div', 'record-actions');
        actions.append(
          makeButton('详情', 'btn small', () => openRecord(record))
        );
        actions.append(
          makeButton('删除', 'btn small danger', () => {
            if (!window.confirm('确定删除这条记录吗？\n' + record.title)) return;
            db.records = db.records.filter((item) => item.id !== record.id);
            persist();
            removeBadgesForRecord(record.id);
            render();
          })
        );

        row.append(main, actions);
        list.append(row);
      }
    };

    search.addEventListener('input', render);

    const footer = el('div', 'footer');
    footer.append(
      makeButton('导出 JSON', 'btn', exportJSON),
      makeButton(
        '清空全部记录',
        'btn danger',
        () => {
          if (
            !window.confirm(
              '确定清空所有站点的点击记录吗？\n站点启用设置会保留，此操作不可撤销。'
            )
          ) {
            return;
          }
          db.records = [];
          persist();
          removeAllBadges();
          render();
        }
      ),
      makeButton('关闭', 'btn', closeOverlay)
    );

    card.append(head, search, list, footer);
    backdrop.append(card);
    render();
  }

  /* ============================================================
     八、菜单与导出
     ============================================================ */

  function exportJSON() {
    const data = JSON.stringify(db, null, 2);
    const blob = new Blob([data], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'download-dedup-' + dateStamp() + '.json';
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function enableCurrentSite() {
    db = loadDB();
    const host = normalizeHost(location.hostname);
    uniquePush(db.settings.enabledSites, host);
    db.settings.disabledSites = db.settings.disabledSites.filter(
      (item) => item !== host
    );
    persist(false);
    location.reload();
  }

  function disableCurrentSite() {
    db = loadDB();
    const host = normalizeHost(location.hostname);
    db.settings.enabledSites = db.settings.enabledSites.filter(
      (item) => item !== host
    );
    uniquePush(db.settings.disabledSites, host);
    persist(false);
    location.reload();
  }

  function clearAllRecords() {
    if (
      !window.confirm(
        '确定清空所有站点的点击记录吗？\n站点启用设置会保留，此操作不可撤销。'
      )
    ) {
      return;
    }
    db.records = [];
    persist();
    removeAllBadges();
    closeOverlay();
  }

  function hasAnySiteConfigured() {
    return (
      SITE_RULES.hostSuffixes.some(Boolean) ||
      SITE_RULES.urlPrefixes.some(Boolean) ||
      db.settings.enabledSites.length > 0
    );
  }

  function showSetupHint() {
    if (!document.body || document.querySelector('[data-dldedup-setup]')) return;

    const host = document.createElement('div');
    host.setAttribute(UI_ATTR, 'setup');
    host.setAttribute('data-dldedup-setup', '1');
    host.style.setProperty('display', 'block', 'important');

    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SETUP_CSS;

    const card = el('div', 'card');
    const head = el('div', 'head');
    head.append(el('div', 'title', '下载去重提醒'));
    const closeButton = makeButton('×', 'close', () => host.remove());
    closeButton.setAttribute('aria-label', '关闭');
    head.append(closeButton);

    const text = el(
      'div',
      'text',
      '本站还没有启用，所以不会记录点击。启用后，点过的标题前面会出现一个彩色数字，表示你看过几次。'
    );

    const actions = el('div', 'actions');
    actions.append(
      makeButton('启用本站', 'btn primary', () => enableCurrentSite()),
      makeButton('暂不', 'btn', () => host.remove())
    );

    card.append(head, text, actions);
    root.append(style, card);

    host.addEventListener('mousedown', (event) => event.stopPropagation());
    host.addEventListener('click', (event) => event.stopPropagation());
    document.body.append(host);
  }

  function showToast(message, duration) {
    if (!document.body) return;
    const existing = document.querySelector('[data-dldedup-toast]');
    if (existing) existing.remove();

    const host = document.createElement('div');
    host.setAttribute(UI_ATTR, 'toast');
    host.setAttribute('data-dldedup-toast', '1');
    host.style.setProperty('display', 'block', 'important');

    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = TOAST_CSS;
    const toast = el('div', 'toast', message);
    root.append(style, toast);

    host.addEventListener('mousedown', (event) => event.stopPropagation());
    host.addEventListener('click', (event) => event.stopPropagation());
    document.body.append(host);

    setTimeout(() => host.remove(), Math.max(1200, Number(duration) || 4200));
  }

  function showDiagnostics() {
    const anchors = document.querySelectorAll('a[href]');
    let candidateCount = 0;
    const samples = [];

    for (const anchor of anchors) {
      if (!(anchor instanceof HTMLAnchorElement)) continue;
      const title = getAnchorTitle(anchor);
      if (!title || !isCandidateTitle(anchor, title)) continue;
      candidateCount += 1;
      if (samples.length < 8) {
        samples.push(title.length > 90 ? title.slice(0, 90) + '…' : title);
      }
    }

    const badgeCount = document.querySelectorAll('[' + BADGE_ATTR + ']').length;
    const lines = [
      '当前站点：' + (currentHost || location.hostname || '未知'),
      '页面链接总数：' + anchors.length,
      '识别为标题链接：' + candidateCount,
      '页面上已显示徽标：' + badgeCount,
      '已记录资源：' + db.records.length,
      '',
      '标题示例：',
      samples.length ? samples.join('\n') : '（没有识别到）',
      '',
      '如果这里显示 0，请把当前页面网址发给我，并告诉我标题链接的大致位置。',
    ];
    window.alert(lines.join('\n'));
  }

  function registerMenus(enabled) {
    if (typeof GM_registerMenuCommand !== 'function') return;

    if (!enabled) {
      GM_registerMenuCommand('▶ 启用“下载去重提醒”于本站', enableCurrentSite);
      return;
    }

    GM_registerMenuCommand('📚 查看已记录资源', openManager);
    GM_registerMenuCommand('🔍 检查本页标题识别', showDiagnostics);
    GM_registerMenuCommand('📤 导出记录 JSON', exportJSON);
    GM_registerMenuCommand('🧹 清空全部记录', clearAllRecords);
    GM_registerMenuCommand('⏸ 停用本站提醒', disableCurrentSite);
  }

  /* ============================================================
     九、页面扫描、点击记录、动态内容监听
     ============================================================ */

  let scanTimer = null;
  let recentClicks = new Map();
  let lastScanInfo = { titleLinks: 0, matched: 0, totalLinks: 0 };
  let initialStatusShown = false;

  function scheduleScan(delay) {
    if (!initialized) return;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      if (document.hidden) return;
      const run = () => scanPage();
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 1200 });
      } else {
        setTimeout(run, 0);
      }
    }, Math.max(0, Number(delay) || 0));
  }

  function scanPage() {
    if (!initialized || !document.body) return;

    const anchors = document.querySelectorAll('a[href]');
    const hasRecords = db.records.length > 0;
    let titleLinks = 0;
    let matched = 0;

    for (const anchor of anchors) {
      if (!(anchor instanceof HTMLAnchorElement)) continue;
      if (anchor.closest('[' + UI_ATTR + ']')) continue;

      const existing = badgeMap.get(anchor);
      const title = getAnchorTitle(anchor);

      if (!title || !isCandidateTitle(anchor, title)) {
        if (existing) removeBadge(anchor);
        continue;
      }

      titleLinks += 1;

      // 还没有任何记录时，不需要对所有链接做标题分析
      if (!hasRecords) {
        if (existing) removeBadge(anchor);
        continue;
      }

      const analysis = analyzeTitleCached(title);
      if (!analysis) {
        if (existing) removeBadge(anchor);
        continue;
      }

      const match = findMatch(analysis);
      if (!match || match.rec.count < CONFIG.showBadgeForCount) {
        if (existing) removeBadge(anchor);
        continue;
      }

      matched += 1;
      upsertBadge(anchor, match.rec);
    }

    lastScanInfo = {
      titleLinks,
      matched,
      totalLinks: anchors.length,
    };
  }

  function handleTitleClick(event) {
    if (!initialized) return;
    if (!event.isTrusted) return;

    let target = event.target;
    if (target && target.nodeType === 3) target = target.parentElement;
    if (!(target instanceof Element)) return;
    if (target.closest('[' + UI_ATTR + ']')) return;

    const anchor = target.closest('a[href]');
    if (!anchor) return;
    if (!isCandidateTitle(anchor)) return;

    const title = getAnchorTitle(anchor);
    const analysis = analyzeTitleCached(title);
    if (!analysis) return;

    const href = anchor.href || anchor.getAttribute('href') || '';
    const dedupeKey = analysis.markerSig + '||' + analysis.core + '||' + href;
    const now = Date.now();
    const previous = recentClicks.get(dedupeKey);
    if (previous && now - previous < CONFIG.clickDedupeMs) return;
    recentClicks.set(dedupeKey, now);

    if (recentClicks.size > 100) {
      for (const [key, timestamp] of recentClicks) {
        if (now - timestamp > 10000) recentClicks.delete(key);
      }
    }

    const url = normalizeUrl(href);
    const match = findMatch(analysis);
    let record;

    if (match) {
      record = match.rec;
      bumpRecord(record, analysis, title, url, now);
    } else {
      record = createRecord(analysis, title, url, now);
      db.records.push(record);
    }

    persist(false);
    upsertBadge(anchor, record);
    refreshBadgesForRecord(record);
    scheduleScan(180);
  }

  function installClickTracking() {
    document.addEventListener(
      'click',
      (event) => {
        if (event.button !== 0) return;
        handleTitleClick(event);
      },
      true
    );

    document.addEventListener(
      'auxclick',
      (event) => {
        if (event.button !== 1) return;
        handleTitleClick(event);
      },
      true
    );
  }

  function isOurMutation(mutation) {
    const nodes = [
      ...Array.from(mutation.addedNodes),
      ...Array.from(mutation.removedNodes),
    ];
    if (!nodes.length) return false;

    return nodes.every((node) => {
      if (node.nodeType === 1) {
        return (
          node.hasAttribute(UI_ATTR) ||
          (node.closest && node.closest('[' + UI_ATTR + ']'))
        );
      }
      return node.nodeType === 3 && !String(node.textContent || '').trim();
    });
  }

  function installObserver() {
    if (!document.documentElement) return;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;
        if (isOurMutation(mutation)) continue;
        if (mutation.addedNodes.length || mutation.removedNodes.length) {
          scheduleScan(450);
          return;
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function installStorageSync() {
    if (typeof GM_addValueChangeListener !== 'function') return;

    try {
      GM_addValueChangeListener(
        STORE_KEY,
        (name, oldValue, newValue, remote) => {
          if (!remote) return;
          try {
            db = normalizeDB(
              typeof newValue === 'string' ? JSON.parse(newValue) : newValue
            );
            rebuildIndex();
            clearMatchCache();
            scheduleScan(100);
          } catch (error) {
            console.warn('[下载去重] 同步其他标签页数据失败', error);
          }
        }
      );
    } catch (error) {
      console.warn('[下载去重] 无法监听存储变化', error);
    }
  }

  /* ============================================================
     十、初始化
     ============================================================ */

  function init() {
    currentHost = normalizeHost(location.hostname);
    db = loadDB();
    rebuildIndex();

    const enabled = isSiteEnabled();
    registerMenus(enabled);
    if (!enabled) {
      if (!hasAnySiteConfigured()) showSetupHint();
      return;
    }

    initialized = true;
    installStorageSync();
    installClickTracking();
    installObserver();
    scheduleScan(250);

    setTimeout(() => {
      if (!initialized || initialStatusShown) return;
      initialStatusShown = true;

      if (db.records.length === 0) {
        showToast(
          lastScanInfo.titleLinks > 0
            ? '下载去重提醒已启用 · 点一个标题试试，返回后标题前会显示次数'
            : '下载去重提醒已启用，但本页还没识别到标题链接；可在 Tampermonkey 菜单里检查'
        );
      } else if (lastScanInfo.titleLinks === 0) {
        showToast(
          '下载去重提醒已启用，但本页没识别到标题链接；可在 Tampermonkey 菜单里检查'
        );
      }
    }, 1800);

    window.addEventListener('pageshow', () => {
      if (!initialized) return;
      db = loadDB();
      rebuildIndex();
      clearMatchCache();
      removeAllBadges();
      scheduleScan(120);
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleScan(250);
    });
  }

  if (typeof window === 'undefined' && typeof module !== 'undefined' && module.exports) {
    module.exports = {
      analyzeTitle,
      coreSimilarity,
      cnNumToInt,
      diceCoefficient,
      longestCommonSubstring,
    };
  } else if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    init();
  }
})();
