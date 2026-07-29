/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * WebMCP ISOLATED World Bridge Script
 * Bridges chrome.storage and chrome.runtime with the MAIN world interceptor.
 */

(function () {
  'use strict';

  // 1. Initial Storage Load & Dispatch to MAIN world
  function loadAndDispatchRules() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;

    chrome.storage.local.get(['webmcp_origin_groups', 'webmcp_settings'], (result) => {
      const originGroups = result.webmcp_origin_groups || [];
      const settings = result.webmcp_settings || {};

      if (settings.globalDisabled) {
        window.dispatchEvent(new CustomEvent('__WEBMCP_STORAGE_UPDATE__', {
          detail: { originGroups: [] }
        }));
        return;
      }

      window.dispatchEvent(new CustomEvent('__WEBMCP_STORAGE_UPDATE__', {
        detail: { originGroups }
      }));
    });
  }

  // Execute storage load immediately at document_start, DOMContentLoaded, and window load
  loadAndDispatchRules();
  document.addEventListener('DOMContentLoaded', loadAndDispatchRules);
  window.addEventListener('load', loadAndDispatchRules);

  // 2. Listen for Storage Changes and sync to MAIN world
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && (changes.webmcp_origin_groups || changes.webmcp_settings)) {
        loadAndDispatchRules();
      }
    });
  }

  // 3. Listen for Audit Logs from MAIN world and forward to Extension Service Worker
  window.addEventListener('__WEBMCP_AUDIT_LOG_EVENT__', (event) => {
    if (!event.detail || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;

    chrome.runtime.sendMessage({
      type: 'WEBMCP_LOG_INTERCEPTION',
      log: event.detail
    }).catch(() => {
      // Background worker might be asleep or reloading
    });
  });

  // 4. Handle runtime messages from Extension Popup or Service Worker
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'WEBMCP_GET_TAB_ORIGIN') {
        sendResponse({ origin: window.location.href });
      }
      return true;
    });
  }

})();
