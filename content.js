// Copyright (c) 2026 李瑞麟
// SPDX-License-Identifier: MIT

(() => {
  'use strict';

  const MESSAGE_MARK = 'sysu-lms-video-auto-next-v1';
  const ENABLED_KEY = 'sysu-lms-video-auto-next-enabled';
  const AUTOPLAY_KEY = 'sysu-lms-video-auto-next-autoplay';
  const ADVANCE_DELAY_MS = 3000;
  const IS_TOP = window === window.top;

  let advancing = false;
  let autoplayStarted = false;
  let panelButton = null;
  let statusNode = null;
  const watchedVideos = new WeakSet();

  function storageGet(storage, key) {
    try {
      return storage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function storageSet(storage, key, value) {
    try {
      storage.setItem(key, value);
    } catch (_) {
      // 隐私模式或站点策略可能禁用存储；不影响本页监听。
    }
  }

  function storageRemove(storage, key) {
    try {
      storage.removeItem(key);
    } catch (_) {
      // 同上。
    }
  }

  function isEnabled() {
    return storageGet(localStorage, ENABLED_KEY) !== 'false';
  }

  function setEnabled(enabled) {
    storageSet(localStorage, ENABLED_KEY, String(enabled));
    updatePanel(enabled ? '等待视频播放完成' : '已关闭');
  }

  function postToTop(type, extra = {}) {
    const message = { mark: MESSAGE_MARK, type, ...extra };
    if (IS_TOP) {
      window.postMessage(message, location.origin);
    } else {
      window.top.postMessage(message, '*');
    }
  }

  function postToChildren(message) {
    for (let i = 0; i < window.frames.length; i += 1) {
      try {
        window.frames[i].postMessage(message, '*');
      } catch (_) {
        // 跨域子框架也允许 postMessage；异常时直接忽略。
      }
    }
  }

  function videoReallyEnded(video) {
    if (!(video instanceof HTMLVideoElement)) return false;
    const duration = Number(video.duration);
    if (video.ended) return true;
    return Number.isFinite(duration)
      && duration >= 5
      && Number(video.currentTime) >= duration - Math.min(0.35, duration * 0.001);
  }

  function reportEnded(video) {
    if (!videoReallyEnded(video)) return;
    postToTop('video-ended', {
      page: location.href,
      duration: Number(video.duration) || 0,
    });
  }

  function watchVideo(video) {
    if (watchedVideos.has(video)) return;
    watchedVideos.add(video);
    video.addEventListener('ended', () => reportEnded(video), true);
    video.addEventListener('timeupdate', () => {
      if (videoReallyEnded(video)) reportEnded(video);
    }, true);
    if (videoReallyEnded(video)) reportEnded(video);
  }

  function scanVideos() {
    document.querySelectorAll('video').forEach(watchVideo);
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function scoreNextLink(link) {
    if (!(link instanceof HTMLAnchorElement)) return -Infinity;

    let url;
    try {
      url = new URL(link.href, location.href);
    } catch (_) {
      return -Infinity;
    }

    if (!/^https?:$/.test(url.protocol) || url.href === location.href) return -Infinity;
    if (url.origin !== location.origin) return -Infinity;

    const text = normalizeText(link.innerText || link.textContent);
    const metadata = normalizeText([
      link.id,
      link.className,
      link.getAttribute('rel'),
      link.getAttribute('title'),
      link.getAttribute('aria-label'),
      link.getAttribute('data-action'),
      link.getAttribute('data-region'),
    ].join(' ')).toLowerCase();
    const html = String(link.innerHTML || '').toLowerCase();

    if (/\b(prev|previous)\b|上一|前一/.test(`${metadata} ${text}`)) return -Infinity;
    if (/^[◄‹«←]/.test(text) || /chevron-left|arrow-left/.test(html)) return -Infinity;

    let score = 0;
    if (link.relList && link.relList.contains('next')) score += 1000;
    if (/\bnext\b|下一|后一/.test(metadata)) score += 700;
    if (/^(下一|后一)|\bnext\b/i.test(text)) score += 600;
    if (/[►›»→]\s*$/.test(text)) score += 550;
    if (/chevron-right|arrow-right|caret-right/.test(html)) score += 500;
    if (link.closest('.activity-navigation, [data-region="activity-navigation"], nav')) score += 250;
    if (/\/mod\/[^/]+\/view\.php/i.test(url.pathname)) score += 120;
    if (link.offsetParent !== null) score += 30;

    return score;
  }

  function findNextLink() {
    const exactSelectors = [
      '#next-activity-link',
      'a[rel="next"]',
      '.activity-navigation a[data-action*="next" i]',
      '.activity-navigation a[data-region*="next" i]',
      '.activity-navigation a[aria-label*="下一"]',
      '.activity-navigation a[title*="下一"]',
    ];

    for (const selector of exactSelectors) {
      try {
        const match = document.querySelector(selector);
        if (match && scoreNextLink(match) > 0) return match;
      } catch (_) {
        // 某些旧版浏览器不支持属性选择器的 i 标志，继续使用通用评分。
      }
    }

    const candidates = Array.from(document.querySelectorAll(
      '.activity-navigation a[href], [data-region="activity-navigation"] a[href], nav a[href], a[href]',
    ));
    const ranked = candidates
      .map((link) => ({ link, score: scoreNextLink(link) }))
      .filter((item) => item.score >= 500)
      .sort((a, b) => b.score - a.score);
    return ranked.length ? ranked[0].link : null;
  }

  function setAutoplayFlag() {
    storageSet(sessionStorage, AUTOPLAY_KEY, JSON.stringify({ time: Date.now() }));
  }

  function consumeAutoplayFlag() {
    const raw = storageGet(sessionStorage, AUTOPLAY_KEY);
    storageRemove(sessionStorage, AUTOPLAY_KEY);
    if (!raw) return false;
    try {
      const data = JSON.parse(raw);
      return Date.now() - Number(data.time) < 120000;
    } catch (_) {
      return false;
    }
  }

  function goToNextActivity() {
    if (advancing || !isEnabled()) return;
    advancing = true;
    updatePanel('视频已结束，3 秒后进入下一节');

    window.setTimeout(() => {
      if (!isEnabled()) {
        advancing = false;
        updatePanel('已关闭，已取消跳转');
        return;
      }

      const next = findNextLink();
      if (!next) {
        advancing = false;
        updatePanel('未找到下一节，可能已是最后一节', true);
        return;
      }

      const nextUrl = next.href;
      setAutoplayFlag();
      updatePanel(`正在进入：${normalizeText(next.innerText || next.title) || '下一节'}`);
      next.click();

      // 如果站点脚本拦截了 click 却没有导航，则直接打开同一链接。
      window.setTimeout(() => {
        if (location.href !== nextUrl) location.assign(nextUrl);
      }, 900);
    }, ADVANCE_DELAY_MS);
  }

  async function tryPlay(video) {
    if (!(video instanceof HTMLVideoElement)) return false;
    if (!video.paused && !video.ended) return true;

    try {
      await video.play();
      return true;
    } catch (_) {
      // 浏览器通常只允许脚本静音自动播放。
    }

    try {
      video.muted = true;
      await video.play();
      postToTop('autoplay-muted');
      return true;
    } catch (_) {
      return false;
    }
  }

  function clickPlayerPlayButton() {
    const selectors = [
      '.vjs-big-play-button',
      '.dplayer-play-icon',
      '.prism-big-play-btn',
      '.xgplayer-start',
      '.plyr__control[data-plyr="play"]',
      'button[aria-label*="播放"]',
      'button[title*="播放"]',
    ];
    for (const selector of selectors) {
      const button = document.querySelector(selector);
      if (button instanceof HTMLElement && button.offsetParent !== null) {
        button.click();
        return true;
      }
    }
    return false;
  }

  function startAutoplayAttempts() {
    if (autoplayStarted || !isEnabled()) return;
    autoplayStarted = true;
    let attempts = 0;

    const timer = window.setInterval(async () => {
      attempts += 1;
      scanVideos();
      const videos = Array.from(document.querySelectorAll('video'));
      clickPlayerPlayButton();

      for (const video of videos) {
        if (await tryPlay(video)) {
          window.clearInterval(timer);
          postToTop('autoplay-ok');
          return;
        }
      }

      if (attempts >= 30) {
        window.clearInterval(timer);
        postToTop('autoplay-failed');
      }
    }, 1000);
  }

  function updatePanel(message, isError = false) {
    if (!IS_TOP || !statusNode) return;
    statusNode.textContent = message;
    statusNode.dataset.error = String(isError);
    statusNode.style.setProperty('color', isError ? '#ffb3b3' : '#ffffff', 'important');
    if (panelButton) panelButton.textContent = `自动连播：${isEnabled() ? '开' : '关'}`;
  }

  function createPanel() {
    if (!IS_TOP || document.getElementById('sysu-auto-next-panel')) return;
    const host = document.createElement('div');
    host.id = 'sysu-auto-next-panel';
    host.style.cssText = [
      'all: initial !important',
      'display: block !important',
      'position: fixed !important',
      'right: 16px !important',
      'bottom: 16px !important',
      'z-index: 2147483647 !important',
      'box-sizing: border-box !important',
      'min-width: 220px !important',
      'max-width: 340px !important',
      'padding: 10px 12px !important',
      'color: #fff !important',
      'background: rgba(25,30,38,.94) !important',
      'border: 1px solid rgba(255,255,255,.25) !important',
      'border-radius: 10px !important',
      'box-shadow: 0 5px 20px rgba(0,0,0,.35) !important',
      'font: 13px/1.45 system-ui,sans-serif !important',
    ].join(';');

    panelButton = document.createElement('button');
    panelButton.type = 'button';
    panelButton.style.cssText = [
      'all: initial !important',
      'display: block !important',
      'box-sizing: border-box !important',
      'width: 100% !important',
      'padding: 7px 10px !important',
      'color: #fff !important',
      'background: #1677ff !important',
      'border: 0 !important',
      'border-radius: 6px !important',
      'cursor: pointer !important',
      'text-align: center !important',
      'font: 600 13px/1.45 system-ui,sans-serif !important',
    ].join(';');

    statusNode = document.createElement('div');
    statusNode.setAttribute('aria-live', 'polite');
    statusNode.style.cssText = [
      'all: initial !important',
      'display: block !important',
      'margin-top: 7px !important',
      'color: #fff !important',
      'font: 13px/1.45 system-ui,sans-serif !important',
      'word-break: break-word !important',
    ].join(';');

    host.append(panelButton, statusNode);
    (document.body || document.documentElement).appendChild(host);
    panelButton.addEventListener('click', () => setEnabled(!isEnabled()));
    panelButton.textContent = `自动连播：${isEnabled() ? '开' : '关'}`;
    statusNode.textContent = isEnabled() ? '等待视频播放完成' : '已关闭';
    console.info('[中大 LMS 自动连播] 正式版 1.0.0 已启动。');
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.mark !== MESSAGE_MARK) return;
    if (event.origin && event.origin !== location.origin && event.origin !== 'null') return;

    if (data.type === 'start-autoplay') {
      startAutoplayAttempts();
      postToChildren(data);
      return;
    }

    if (!IS_TOP) return;

    if (data.type === 'video-ended') goToNextActivity();
    if (data.type === 'autoplay-ok') updatePanel('下一节已开始播放');
    if (data.type === 'autoplay-muted') updatePanel('下一节已静音播放，点击播放器可恢复声音');
    if (data.type === 'autoplay-failed') updatePanel('自动播放被浏览器拦截，请手动点一次播放', true);
  });

  function init() {
    scanVideos();
    new MutationObserver(scanVideos).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    if (IS_TOP) {
      createPanel();
      if (consumeAutoplayFlag() && isEnabled()) {
        const message = { mark: MESSAGE_MARK, type: 'start-autoplay' };
        updatePanel('正在加载并播放下一节');
        window.postMessage(message, location.origin);
        postToChildren(message);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

