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
 * Rules Store Engine (chrome.storage.local wrapper)
 * Handles persistence, schema normalization, and active group filtering.
 */

import { DEFAULT_ORIGIN_GROUPS, DEFAULT_SETTINGS } from './default-rules.js';

const STORAGE_KEYS = {
  ORIGIN_GROUPS: 'webmcp_origin_groups',
  SETTINGS: 'webmcp_settings',
  LOGS: 'webmcp_interception_logs'
};

/**
 * Generate a unique random UUID string.
 * @returns {string}
 */
export function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'id-' + Math.random().toString(36).substring(2, 11) + '-' + Date.now().toString(36);
}

/**
 * Normalize an Origin Rule Group object ensuring default property values.
 * @param {Object} group 
 * @returns {Object}
 */
export function normalizeOriginGroup(group) {
  if (!group || typeof group !== 'object') return null;

  return {
    id: group.id || generateUUID(),
    name: group.name || group.originPattern || 'Unnamed Group',
    originPattern: group.originPattern || '*://*/*',
    disabled: Boolean(group.disabled), // Default false (active)
    rules: Array.isArray(group.rules) ? group.rules.map(normalizeRule).filter(Boolean) : [],
    createdAt: group.createdAt || Date.now(),
    updatedAt: group.updatedAt || Date.now()
  };
}

/**
 * Normalize an individual WebMCP rule.
 * @param {Object} rule 
 * @returns {Object}
 */
export function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object') return null;

  return {
    id: rule.id || generateUUID(),
    name: rule.name || `${rule.actionType.toUpperCase()} rule`,
    disabled: Boolean(rule.disabled), // Default false (active)
    actionType: ['block', 'rename', 'rewrite', 'rename_param', 'rewrite_param_desc', 'inject'].includes(rule.actionType) ? rule.actionType : 'block',
    targetToolName: rule.targetToolName || '*',
    isRegexPattern: Boolean(rule.isRegexPattern),
    targetParam: rule.targetParam || '',
    renameTo: rule.renameTo || '',
    rewriteConfig: rule.rewriteConfig || { mode: 'static', replacement: '' },
    injectedTool: rule.injectedTool || {
      name: 'synthetic_tool',
      description: 'Injected tool definition',
      inputSchema: { type: 'object' },
      handlerType: 'js_script',
      customScript: '(args) => ({ ok: true })'
    }
  };
}

/**
 * Get all stored Origin Rule Groups.
 * @returns {Promise<Array>}
 */
export async function getOriginGroups() {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      resolve(DEFAULT_ORIGIN_GROUPS.map(normalizeOriginGroup));
      return;
    }

    chrome.storage.local.get([STORAGE_KEYS.ORIGIN_GROUPS], (result) => {
      let groups = result[STORAGE_KEYS.ORIGIN_GROUPS];
      if (!groups || !Array.isArray(groups)) {
        groups = DEFAULT_ORIGIN_GROUPS;
        chrome.storage.local.set({ [STORAGE_KEYS.ORIGIN_GROUPS]: groups });
      }
      resolve(groups.map(normalizeOriginGroup));
    });
  });
}

/**
 * Save all Origin Rule Groups.
 * @param {Array} groups 
 * @returns {Promise<void>}
 */
export async function saveOriginGroups(groups) {
  const normalized = (groups || []).map(normalizeOriginGroup).filter(Boolean);
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      resolve();
      return;
    }
    chrome.storage.local.set({ [STORAGE_KEYS.ORIGIN_GROUPS]: normalized }, () => {
      resolve();
    });
  });
}

/**
 * Get Extension Settings.
 * @returns {Promise<Object>}
 */
export async function getSettings() {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      resolve({ ...DEFAULT_SETTINGS });
      return;
    }

    chrome.storage.local.get([STORAGE_KEYS.SETTINGS], (result) => {
      const settings = { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEYS.SETTINGS] || {}) };
      resolve(settings);
    });
  });
}

/**
 * Save Extension Settings.
 * @param {Object} newSettings 
 * @returns {Promise<void>}
 */
export async function saveSettings(newSettings) {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      resolve();
      return;
    }
    getSettings().then(current => {
      const updated = { ...current, ...newSettings };
      chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: updated }, () => {
        resolve();
      });
    });
  });
}

/**
 * Append an interception event to audit logs.
 * @param {Object} logEntry 
 * @returns {Promise<void>}
 */
export async function addAuditLog(logEntry) {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      resolve();
      return;
    }

    chrome.storage.local.get([STORAGE_KEYS.LOGS, STORAGE_KEYS.SETTINGS], (result) => {
      const logs = result[STORAGE_KEYS.LOGS] || [];
      const settings = { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEYS.SETTINGS] || {}) };

      if (!settings.logInterceptions) {
        resolve();
        return;
      }

      const newLog = {
        id: generateUUID(),
        timestamp: Date.now(),
        ...logEntry
      };

      logs.unshift(newLog);

      // Trim logs exceeding maxLogEntries
      const maxLogs = settings.maxLogEntries || 200;
      if (logs.length > maxLogs) {
        logs.length = maxLogs;
      }

      chrome.storage.local.set({ [STORAGE_KEYS.LOGS]: logs }, () => {
        resolve();
      });
    });
  });
}

/**
 * Retrieve Audit Logs.
 * @returns {Promise<Array>}
 */
export async function getAuditLogs() {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      resolve([]);
      return;
    }

    chrome.storage.local.get([STORAGE_KEYS.LOGS], (result) => {
      resolve(result[STORAGE_KEYS.LOGS] || []);
    });
  });
}

/**
 * Clear Audit Logs.
 * @returns {Promise<void>}
 */
export async function clearAuditLogs() {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      resolve();
      return;
    }

    chrome.storage.local.set({ [STORAGE_KEYS.LOGS]: [] }, () => {
      resolve();
    });
  });
}
