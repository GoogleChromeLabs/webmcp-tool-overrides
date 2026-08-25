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
 * Extension Popup Logic
 */

import { getOriginGroups, getSettings, saveSettings } from '../storage/rules-store.js';
import { matchOrigin } from '../utils/pattern-matcher.js';

document.addEventListener('DOMContentLoaded', async () => {
  const currentOriginText = document.getElementById('currentOriginText');
  const originDot = document.getElementById('originDot');
  const globalToggle = document.getElementById('globalToggle');
  const groupsContainer = document.getElementById('groupsContainer');
  const openDashboardBtn = document.getElementById('openDashboardBtn');

  // Load Settings
  const settings = await getSettings();
  globalToggle.checked = !settings.globalDisabled;

  globalToggle.addEventListener('change', async () => {
    await saveSettings({ globalDisabled: !globalToggle.checked });
    updateOriginDot();
  });

  function updateOriginDot() {
    if (globalToggle.checked) {
      originDot.classList.remove('disabled');
    } else {
      originDot.classList.add('disabled');
    }
  }

  // Get Active Tab Origin
  let currentUrl = 'http://localhost/';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.startsWith('http')) {
      currentUrl = tab.url;
    }
  } catch {
    /* ignore */
  }

  try {
    const u = new URL(currentUrl);
    currentOriginText.textContent = u.hostname + u.pathname;
  } catch {
    currentOriginText.textContent = currentUrl;
  }

  // Load Matching Origin Groups
  const groups = await getOriginGroups();
  const activeMatchingGroups = groups.filter(
    (g) => !g.disabled && matchOrigin(currentUrl, g.originPattern),
  );

  // Render UI safely using textContent / DOM methods
  groupsContainer.replaceChildren();

  if (activeMatchingGroups.length === 0) {
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';
    emptyState.textContent = 'No active override rules matching this origin.';
    groupsContainer.appendChild(emptyState);
  } else {
    activeMatchingGroups.forEach((group) => {
      const card = document.createElement('div');
      card.className = 'group-card';

      const header = document.createElement('div');
      header.className = 'group-header';

      const nameEl = document.createElement('span');
      nameEl.className = 'group-name';
      nameEl.textContent = group.name;

      const patternEl = document.createElement('span');
      patternEl.className = 'group-pattern';
      patternEl.textContent = group.originPattern;

      header.appendChild(nameEl);
      header.appendChild(patternEl);
      card.appendChild(header);

      const pillList = document.createElement('div');
      pillList.className = 'rule-pill-list';

      const rules = (group.rules || []).filter((r) => !r.disabled);
      if (rules.length === 0) {
        const noRules = document.createElement('span');
        noRules.style.fontSize = '10px';
        noRules.style.color = '#94a3b8';
        noRules.textContent = 'No active rules';
        pillList.appendChild(noRules);
      } else {
        rules.forEach((rule) => {
          const pill = document.createElement('span');
          pill.className = `rule-pill ${rule.actionType}`;
          let label = `${rule.actionType.toUpperCase()}: `;

          if (rule.actionType === 'inject') {
            label += rule.injectedTool ? rule.injectedTool.name : 'synthetic';
          } else if (rule.actionType === 'rename') {
            label += `${rule.targetToolName} ➔ ${rule.renameTo}`;
          } else {
            label += rule.targetToolName;
          }

          pill.textContent = label;
          pillList.appendChild(pill);
        });
      }

      card.appendChild(pillList);
      groupsContainer.appendChild(card);
    });
  }

  // Open Dashboard
  openDashboardBtn.addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('dashboard/dashboard.html'));
    }
  });
});
