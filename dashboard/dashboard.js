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
 * WebMCP Dashboard Controller
 */

import {
  getOriginGroups,
  saveOriginGroups,
  getSettings,
  saveSettings,
  getAuditLogs,
  clearAuditLogs,
  generateUUID,
  normalizeOriginGroup,
  normalizeRule
} from '../storage/rules-store.js';

import { evaluateToolRegistration, getInjectedToolsForOrigin } from '../engine/rule-evaluator.js';

document.addEventListener('DOMContentLoaded', async () => {
  let originGroups = await getOriginGroups();
  let currentEditingGroupId = null;
  let currentEditingRuleId = null;

  // UI Elements
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  const originGroupsList = document.getElementById('originGroupsList');
  const exportBtn = document.getElementById('exportBtn');
  const importBtn = document.getElementById('importBtn');
  const importFileInput = document.getElementById('importFileInput');
  const addOriginGroupBtn = document.getElementById('addOriginGroupBtn');

  // Modals
  const groupModal = document.getElementById('groupModal');
  const groupModalTitle = document.getElementById('groupModalTitle');
  const groupNameInput = document.getElementById('groupNameInput');
  const groupOriginInput = document.getElementById('groupOriginInput');
  const saveGroupModalBtn = document.getElementById('saveGroupModalBtn');
  const cancelGroupModalBtn = document.getElementById('cancelGroupModalBtn');
  const closeGroupModalBtn = document.getElementById('closeGroupModalBtn');

  const ruleModal = document.getElementById('ruleModal');
  const ruleModalTitle = document.getElementById('ruleModalTitle');
  const ruleActionTypeInput = document.getElementById('ruleActionTypeInput');
  const ruleTargetToolInput = document.getElementById('ruleTargetToolInput');
  const ruleIsRegexInput = document.getElementById('ruleIsRegexInput');
  const ruleRenameToInput = document.getElementById('ruleRenameToInput');
  const ruleRewriteModeInput = document.getElementById('ruleRewriteModeInput');
  const ruleRewriteReplacementInput = document.getElementById('ruleRewriteReplacementInput');
  const ruleInjectNameInput = document.getElementById('ruleInjectNameInput');
  const ruleInjectDescInput = document.getElementById('ruleInjectDescInput');
  const ruleInjectHandlerTypeInput = document.getElementById('ruleInjectHandlerTypeInput');
  const ruleInjectScriptInput = document.getElementById('ruleInjectScriptInput');
  const saveRuleModalBtn = document.getElementById('saveRuleModalBtn');
  const cancelRuleModalBtn = document.getElementById('cancelRuleModalBtn');
  const closeRuleModalBtn = document.getElementById('closeRuleModalBtn');

  const standardRuleFields = document.getElementById('standardRuleFields');
  const renameFields = document.getElementById('renameFields');
  const rewriteFields = document.getElementById('rewriteFields');
  const injectFields = document.getElementById('injectFields');

  // Simulator & Logs Elements
  const simOrigin = document.getElementById('simOrigin');
  const simToolName = document.getElementById('simToolName');
  const simToolDesc = document.getElementById('simToolDesc');
  const runSimBtn = document.getElementById('runSimBtn');
  const simOutput = document.getElementById('simOutput');

  const logsOutput = document.getElementById('logsOutput');
  const clearLogsBtn = document.getElementById('clearLogsBtn');

  // Settings
  const settingLogInterceptions = document.getElementById('settingLogInterceptions');
  const settingAutomationServer = document.getElementById('settingAutomationServer');
  const settingAutomationUrl = document.getElementById('settingAutomationUrl');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');

  // --- Tab Switcher ---
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const targetTab = document.getElementById(btn.dataset.tab);
      if (targetTab) targetTab.classList.add('active');

      if (btn.dataset.tab === 'logs-tab') {
        renderAuditLogs();
      }
    });
  });

  // --- Render Origin Rule Groups ---
  function renderOriginGroups() {
    originGroupsList.replaceChildren();

    if (!originGroups || originGroups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'origin-card';
      empty.style.textAlign = 'center';
      empty.textContent = 'No Origin Rule Groups configured yet. Click "New Origin Group" to create one.';
      originGroupsList.appendChild(empty);
      return;
    }

    originGroups.forEach(group => {
      const card = document.createElement('div');
      card.className = `origin-card ${group.disabled ? 'disabled-group' : ''}`;

      const cardHeader = document.createElement('div');
      cardHeader.className = 'origin-card-header';

      const info = document.createElement('div');
      info.className = 'origin-info';

      const title = document.createElement('span');
      title.className = 'group-title';
      title.textContent = group.name;

      const patternChip = document.createElement('span');
      patternChip.className = 'origin-pattern-chip';
      patternChip.textContent = group.originPattern;

      info.appendChild(title);
      info.appendChild(patternChip);

      const actions = document.createElement('div');
      actions.className = 'group-actions';

      // Group Active Switch
      const switchLabel = document.createElement('label');
      switchLabel.className = 'switch';
      const switchInput = document.createElement('input');
      switchInput.type = 'checkbox';
      switchInput.checked = !group.disabled;
      switchInput.addEventListener('change', async () => {
        group.disabled = !switchInput.checked;
        await saveOriginGroups(originGroups);
        renderOriginGroups();
      });
      const slider = document.createElement('span');
      slider.className = 'slider';
      switchLabel.appendChild(switchInput);
      switchLabel.appendChild(slider);

      const addRuleBtn = document.createElement('button');
      addRuleBtn.className = 'btn btn-sm btn-primary';
      addRuleBtn.textContent = '➕ Add Rule';
      addRuleBtn.addEventListener('click', () => openRuleModal(group.id));

      const editGroupBtn = document.createElement('button');
      editGroupBtn.className = 'btn btn-sm';
      editGroupBtn.textContent = '✏️ Edit Group';
      editGroupBtn.addEventListener('click', () => openGroupModal(group.id));

      const deleteGroupBtn = document.createElement('button');
      deleteGroupBtn.className = 'btn btn-sm btn-danger';
      deleteGroupBtn.textContent = '🗑️ Delete';
      deleteGroupBtn.addEventListener('click', async () => {
        if (confirm(`Delete origin group "${group.name}"?`)) {
          originGroups = originGroups.filter(g => g.id !== group.id);
          await saveOriginGroups(originGroups);
          renderOriginGroups();
        }
      });

      actions.appendChild(switchLabel);
      actions.appendChild(addRuleBtn);
      actions.appendChild(editGroupBtn);
      actions.appendChild(deleteGroupBtn);

      cardHeader.appendChild(info);
      cardHeader.appendChild(actions);
      card.appendChild(cardHeader);

      // Child Rules Container
      const rulesContainer = document.createElement('div');
      rulesContainer.className = 'rules-container';

      if (!group.rules || group.rules.length === 0) {
        const noRules = document.createElement('div');
        noRules.style.fontSize = '12px';
        noRules.style.color = '#94a3b8';
        noRules.style.padding = '8px';
        noRules.textContent = 'No rules inside this origin group. Click "Add Rule" to add one.';
        rulesContainer.appendChild(noRules);
      } else {
        group.rules.forEach(rule => {
          const ruleRow = document.createElement('div');
          ruleRow.className = `rule-row ${rule.disabled ? 'disabled-rule' : ''}`;

          const badge = document.createElement('div');
          badge.className = `rule-badge ${rule.actionType}`;
          badge.textContent = rule.actionType;

          const details = document.createElement('div');
          details.className = 'rule-details';

          const target = document.createElement('div');
          target.className = 'rule-target';

          const desc = document.createElement('div');
          desc.className = 'rule-desc';

          if (rule.actionType === 'inject') {
            target.textContent = `INJECT: ${rule.injectedTool ? rule.injectedTool.name : 'synthetic'}`;
            desc.textContent = rule.injectedTool ? rule.injectedTool.description : '';
          } else if (rule.actionType === 'rename') {
            target.textContent = `RENAME: ${rule.targetToolName} ➔ ${rule.renameTo}`;
            desc.textContent = rule.name || 'Rename rule';
          } else if (rule.actionType === 'rewrite') {
            target.textContent = `REWRITE: ${rule.targetToolName}`;
            desc.textContent = `Mode: ${rule.rewriteConfig ? rule.rewriteConfig.mode : 'static'} | Replacement: "${rule.rewriteConfig ? rule.rewriteConfig.replacement : ''}"`;
          } else {
            target.textContent = `BLOCK: ${rule.targetToolName}`;
            desc.textContent = rule.name || 'Block rule';
          }

          details.appendChild(target);
          details.appendChild(desc);

          const ruleActions = document.createElement('div');
          ruleActions.style.display = 'flex';
          ruleActions.style.alignItems = 'center';
          ruleActions.style.gap = '8px';

          // Rule Active Switch
          const rSwitchLabel = document.createElement('label');
          rSwitchLabel.className = 'switch';
          const rSwitchInput = document.createElement('input');
          rSwitchInput.type = 'checkbox';
          rSwitchInput.checked = !rule.disabled;
          rSwitchInput.addEventListener('change', async () => {
            rule.disabled = !rSwitchInput.checked;
            await saveOriginGroups(originGroups);
            renderOriginGroups();
          });
          const rSlider = document.createElement('span');
          rSlider.className = 'slider';
          rSwitchLabel.appendChild(rSwitchInput);
          rSwitchLabel.appendChild(rSlider);

          const editRuleBtn = document.createElement('button');
          editRuleBtn.className = 'btn btn-sm';
          editRuleBtn.textContent = '✏️';
          editRuleBtn.addEventListener('click', () => openRuleModal(group.id, rule.id));

          const deleteRuleBtn = document.createElement('button');
          deleteRuleBtn.className = 'btn btn-sm btn-danger';
          deleteRuleBtn.textContent = '✕';
          deleteRuleBtn.addEventListener('click', async () => {
            group.rules = group.rules.filter(r => r.id !== rule.id);
            await saveOriginGroups(originGroups);
            renderOriginGroups();
          });

          ruleActions.appendChild(rSwitchLabel);
          ruleActions.appendChild(editRuleBtn);
          ruleActions.appendChild(deleteRuleBtn);

          ruleRow.appendChild(badge);
          ruleRow.appendChild(details);
          ruleRow.appendChild(ruleActions);

          rulesContainer.appendChild(ruleRow);
        });
      }

      card.appendChild(rulesContainer);
      originGroupsList.appendChild(card);
    });
  }

  // --- Origin Group Modal Logic ---
  function openGroupModal(groupId = null) {
    currentEditingGroupId = groupId;
    if (groupId) {
      const g = originGroups.find(x => x.id === groupId);
      if (g) {
        groupModalTitle.textContent = 'Edit Origin Group';
        groupNameInput.value = g.name;
        groupOriginInput.value = g.originPattern;
      }
    } else {
      groupModalTitle.textContent = 'New Origin Group';
      groupNameInput.value = '';
      groupOriginInput.value = '*://*.example.com/*';
    }
    groupModal.classList.add('active');
  }

  function closeGroupModal() {
    groupModal.classList.remove('active');
  }

  saveGroupModalBtn.addEventListener('click', async () => {
    const name = groupNameInput.value.trim() || 'Unnamed Origin Group';
    const originPattern = groupOriginInput.value.trim() || '*://*/*';

    if (currentEditingGroupId) {
      const g = originGroups.find(x => x.id === currentEditingGroupId);
      if (g) {
        g.name = name;
        g.originPattern = originPattern;
        g.updatedAt = Date.now();
      }
    } else {
      const newGroup = normalizeOriginGroup({
        id: generateUUID(),
        name,
        originPattern,
        disabled: false,
        rules: []
      });
      originGroups.push(newGroup);
    }

    await saveOriginGroups(originGroups);
    closeGroupModal();
    renderOriginGroups();
  });

  addOriginGroupBtn.addEventListener('click', () => openGroupModal());
  cancelGroupModalBtn.addEventListener('click', closeGroupModal);
  closeGroupModalBtn.addEventListener('click', closeGroupModal);

  // --- Rule Modal Logic ---
  function updateRuleModalFormFields() {
    const actionType = ruleActionTypeInput.value;
    standardRuleFields.style.display = actionType === 'inject' ? 'none' : 'block';
    renameFields.style.display = actionType === 'rename' ? 'block' : 'none';
    rewriteFields.style.display = actionType === 'rewrite' ? 'block' : 'none';
    injectFields.style.display = actionType === 'inject' ? 'block' : 'none';
  }

  ruleActionTypeInput.addEventListener('change', updateRuleModalFormFields);

  function openRuleModal(groupId, ruleId = null) {
    currentEditingGroupId = groupId;
    currentEditingRuleId = ruleId;

    const group = originGroups.find(g => g.id === groupId);
    if (!group) return;

    if (ruleId) {
      const r = group.rules.find(x => x.id === ruleId);
      if (r) {
        ruleModalTitle.textContent = 'Edit Rule';
        ruleActionTypeInput.value = r.actionType;
        ruleTargetToolInput.value = r.targetToolName || '';
        ruleIsRegexInput.checked = Boolean(r.isRegexPattern);
        ruleRenameToInput.value = r.renameTo || '';
        ruleRewriteModeInput.value = r.rewriteConfig ? r.rewriteConfig.mode : 'static';
        ruleRewriteReplacementInput.value = r.rewriteConfig ? r.rewriteConfig.replacement : '';
        ruleInjectNameInput.value = r.injectedTool ? r.injectedTool.name : '';
        ruleInjectDescInput.value = r.injectedTool ? r.injectedTool.description : '';
        ruleInjectHandlerTypeInput.value = r.injectedTool ? r.injectedTool.handlerType : 'js_script';
        ruleInjectScriptInput.value = r.injectedTool ? r.injectedTool.customScript : '';
      }
    } else {
      ruleModalTitle.textContent = 'Add Rule to ' + group.name;
      ruleActionTypeInput.value = 'block';
      ruleTargetToolInput.value = '';
      ruleIsRegexInput.checked = false;
      ruleRenameToInput.value = '';
      ruleRewriteModeInput.value = 'static';
      ruleRewriteReplacementInput.value = '';
      ruleInjectNameInput.value = 'synthetic_tool';
      ruleInjectDescInput.value = 'Injected tool definition';
      ruleInjectHandlerTypeInput.value = 'js_script';
      ruleInjectScriptInput.value = '(args) => ({ status: "success", data: args })';
    }

    updateRuleModalFormFields();
    ruleModal.classList.add('active');
  }

  function closeRuleModal() {
    ruleModal.classList.remove('active');
  }

  saveRuleModalBtn.addEventListener('click', async () => {
    const group = originGroups.find(g => g.id === currentEditingGroupId);
    if (!group) return;

    const actionType = ruleActionTypeInput.value;
    const ruleObj = normalizeRule({
      id: currentEditingRuleId || generateUUID(),
      actionType,
      targetToolName: ruleTargetToolInput.value.trim() || '*',
      isRegexPattern: ruleIsRegexInput.checked,
      renameTo: ruleRenameToInput.value.trim(),
      rewriteConfig: {
        mode: ruleRewriteModeInput.value,
        replacement: ruleRewriteReplacementInput.value
      },
      injectedTool: {
        name: ruleInjectNameInput.value.trim() || 'synthetic_tool',
        description: ruleInjectDescInput.value.trim(),
        inputSchema: { type: 'object' },
        handlerType: ruleInjectHandlerTypeInput.value,
        customScript: ruleInjectScriptInput.value
      },
      disabled: false
    });

    if (currentEditingRuleId) {
      const idx = group.rules.findIndex(r => r.id === currentEditingRuleId);
      if (idx !== -1) group.rules[idx] = ruleObj;
    } else {
      group.rules.push(ruleObj);
    }

    await saveOriginGroups(originGroups);
    closeRuleModal();
    renderOriginGroups();
  });

  cancelRuleModalBtn.addEventListener('click', closeRuleModal);
  closeRuleModalBtn.addEventListener('click', closeRuleModal);

  // --- Export & Import JSON ---
  exportBtn.addEventListener('click', () => {
    const jsonStr = JSON.stringify(originGroups, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `webmcp-rules-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  importBtn.addEventListener('click', () => importFileInput.click());

  importFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const imported = JSON.parse(evt.target.result);
        if (Array.isArray(imported)) {
          originGroups = imported.map(normalizeOriginGroup).filter(Boolean);
          await saveOriginGroups(originGroups);
          renderOriginGroups();
          alert('Rules imported successfully!');
        } else {
          alert('Invalid JSON format: Expected array of origin groups.');
        }
      } catch (err) {
        alert('Failed to parse JSON file.');
      }
    };
    reader.readAsText(file);
  });

  // --- Simulator Runner ---
  runSimBtn.addEventListener('click', () => {
    const origin = simOrigin.value.trim() || 'https://shop.example.com';
    const toolName = simToolName.value.trim() || 'search_catalog';
    const toolDesc = simToolDesc.value.trim() || 'Search catalog items';

    const testTool = { name: toolName, description: toolDesc };
    const evalResult = evaluateToolRegistration(testTool, originGroups, origin);
    const injected = getInjectedToolsForOrigin(originGroups, origin);

    let outputText = `=== WEBMCP SIMULATION RUN ===\n`;
    outputText += `Target Origin: ${origin}\n`;
    outputText += `Input Tool Payload: ${JSON.stringify(testTool, null, 2)}\n\n`;

    outputText += `--- EVALUATION RESULT ---\n`;
    outputText += `Action Taken: ${evalResult.action.toUpperCase()}\n`;
    if (evalResult.action === 'blocked') {
      outputText += `Status: 🛑 BLOCKED (Tool suppressed)\n`;
    } else {
      outputText += `Final Registered Tool: ${JSON.stringify(evalResult.tool, null, 2)}\n`;
    }

    if (evalResult.logs && evalResult.logs.length) {
      outputText += `\nApplied Rule Logs:\n${JSON.stringify(evalResult.logs, null, 2)}\n`;
    }

    if (injected.length > 0) {
      outputText += `\n--- SYNTHETIC INJECTED TOOLS FOR THIS ORIGIN ---\n`;
      const injectedSummary = injected.map(t => ({ name: t.name, description: t.description }));
      outputText += JSON.stringify(injectedSummary, null, 2);
    }

    simOutput.textContent = outputText;
  });

  // --- Audit Logs View ---
  async function renderAuditLogs() {
    const logs = await getAuditLogs();
    if (!logs || logs.length === 0) {
      logsOutput.textContent = 'No audit log events recorded yet.';
      return;
    }

    let text = `Total Log Entries: ${logs.length}\n\n`;
    logs.forEach(log => {
      const date = new Date(log.timestamp).toLocaleTimeString();
      text += `[${date}] [${log.origin}] ${log.actionTaken.toUpperCase()}: ${log.originalToolName}`;
      if (log.finalToolName) text += ` ➔ ${log.finalToolName}`;
      text += ` (Group: ${log.groupName || log.groupId})\n`;
    });

    logsOutput.textContent = text;
  }

  clearLogsBtn.addEventListener('click', async () => {
    await clearAuditLogs();
    renderAuditLogs();
  });

  // --- Settings Tab ---
  const initialSettings = await getSettings();
  settingLogInterceptions.checked = Boolean(initialSettings.logInterceptions);
  settingAutomationServer.checked = Boolean(initialSettings.automationServerEnabled);
  settingAutomationUrl.value = initialSettings.automationServerUrl || 'http://127.0.0.1:8999/webmcp-rules.json';

  saveSettingsBtn.addEventListener('click', async () => {
    await saveSettings({
      logInterceptions: settingLogInterceptions.checked,
      automationServerEnabled: settingAutomationServer.checked,
      automationServerUrl: settingAutomationUrl.value.trim()
    });
    alert('Settings saved successfully!');
  });

  // Initial Render
  renderOriginGroups();
});
