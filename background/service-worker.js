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
 * WebMCP Extension Background Service Worker
 * Handles storage sync, badge updates, audit logging, and local automation HTTP server polling.
 */

import {
  getOriginGroups,
  getSettings,
  addAuditLog,
  saveOriginGroups,
} from '../storage/rules-store.js';
import { matchOrigin } from '../utils/pattern-matcher.js';

// Map tabId -> count of intercepted events
const tabBadgeCounts = new Map();

// Helper to update Extension Badge per tab
function updateTabBadge(tabId, count) {
  if (typeof chrome === 'undefined' || !chrome.action) return;

  const currentCount = (tabBadgeCounts.get(tabId) || 0) + (count || 1);
  tabBadgeCounts.set(tabId, currentCount);

  chrome.action.setBadgeText({
    tabId,
    text: String(currentCount),
  });

  chrome.action.setBadgeBackgroundColor({
    tabId,
    color: '#8b5cf6', // Vibrant violet badge color
  });
}

// Reset badge on tab navigation
if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
      tabBadgeCounts.set(tabId, 0);
      if (chrome.action) {
        chrome.action.setBadgeText({ tabId, text: '' });
      }
    }
  });
}

// Message Router
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'WEBMCP_LOG_INTERCEPTION') {
      if (sender.tab && sender.tab.id) {
        updateTabBadge(sender.tab.id, 1);
      }
      if (message.log) {
        addAuditLog(message.log);
      }
      sendResponse({ status: 'logged' });
    } else if (message.type === 'WEBMCP_GET_ACTIVE_GROUPS_FOR_ORIGIN') {
      const origin = message.origin;
      getOriginGroups().then((groups) => {
        const activeForOrigin = groups.filter(
          (g) => !g.disabled && matchOrigin(origin, g.originPattern),
        );
        sendResponse({ groups: activeForOrigin });
      });
      return true; // Async response
    }
    return true;
  });
}

// Optional Automation Server Polling (Runs if automationServerEnabled is true in settings)
async function checkAutomationServer() {
  try {
    const settings = await getSettings();
    if (!settings.automationServerEnabled || !settings.automationServerUrl) {
      return;
    }

    const response = await fetch(settings.automationServerUrl, { cache: 'no-store' });
    if (response.ok) {
      const remoteOriginGroups = await response.json();
      if (Array.isArray(remoteOriginGroups)) {
        await saveOriginGroups(remoteOriginGroups);
        console.log(
          '[WebMCP Background] Origin groups synced from local server:',
          settings.automationServerUrl,
        );
      }
    }
  } catch {
    // Polling silent fallback when automation server is not running
  }
}

// Start 5-second polling interval for local automation HTTP server
if (typeof setInterval !== 'undefined') {
  setInterval(checkAutomationServer, 5000);
}
