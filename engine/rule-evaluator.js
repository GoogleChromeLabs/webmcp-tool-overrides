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
 * Core WebMCP Rule Evaluator
 * Evaluates origin groups and child rules against registered WebMCP tools.
 */

import { matchOrigin, matchToolName } from '../utils/pattern-matcher.js';

/**
 * Evaluates a proposed tool registration against active origin groups.
 * 
 * @param {Object} tool - Proposed tool definition: { name, description, parameters, inputSchema, execute }
 * @param {Array} originGroups - List of OriginRuleGroup objects
 * @param {string} currentOrigin - Current page origin (e.g. window.location.origin)
 * @returns {Object} { action: 'allow'|'blocked'|'modified', tool: Object, logs: Array }
 */
export function evaluateToolRegistration(tool, originGroups, currentOrigin) {
  if (!tool || typeof tool !== 'object' || !tool.name) {
    return { action: 'allow', tool, logs: [] };
  }

  // Deep clone tool to prevent accidental mutation during evaluation
  let currentTool = {
    ...tool,
    name: String(tool.name),
    description: tool.description ? String(tool.description) : ''
  };

  const logs = [];
  let isModified = false;

  // Filter matching active origin groups
  const matchingGroups = (originGroups || []).filter(group => {
    if (group.disabled) return false;
    return matchOrigin(currentOrigin, group.originPattern);
  });

  for (const group of matchingGroups) {
    const activeRules = (group.rules || []).filter(r => !r.disabled);

    for (const rule of activeRules) {
      if (rule.actionType === 'inject') continue; // Handled during initial document_start injection

      if (matchToolName(currentTool.name, rule.targetToolName, rule.isRegexPattern)) {
        if (rule.actionType === 'block') {
          logs.push({
            actionTaken: 'blocked',
            originalToolName: tool.name,
            originalDescription: tool.description,
            groupId: group.id,
            groupName: group.name,
            ruleId: rule.id,
            ruleName: rule.name
          });
          return { action: 'blocked', tool: null, logs };
        }

        if (rule.actionType === 'rename' && rule.renameTo) {
          const prevName = currentTool.name;
          currentTool.name = rule.renameTo;
          isModified = true;
          logs.push({
            actionTaken: 'renamed',
            originalToolName: prevName,
            finalToolName: currentTool.name,
            groupId: group.id,
            groupName: group.name,
            ruleId: rule.id,
            ruleName: rule.name
          });
        }

        if (rule.actionType === 'rewrite' && rule.rewriteConfig) {
          const prevDesc = currentTool.description;
          const config = rule.rewriteConfig;

          if (config.mode === 'static') {
            currentTool.description = config.replacement || '';
          } else if (config.mode === 'prepend') {
            currentTool.description = (config.replacement || '') + currentTool.description;
          } else if (config.mode === 'append') {
            currentTool.description = currentTool.description + (config.replacement || '');
          } else if (config.mode === 'regex_replace' && config.pattern) {
            try {
              const rx = new RegExp(config.pattern, 'g');
              currentTool.description = currentTool.description.replace(rx, config.replacement || '');
            } catch (err) {
              console.warn('[WebMCP Engine] Regex replace error:', err);
            }
          }

          isModified = true;
          logs.push({
            actionTaken: 'rewritten',
            originalToolName: tool.name,
            originalDescription: prevDesc,
            finalDescription: currentTool.description,
            groupId: group.id,
            groupName: group.name,
            ruleId: rule.id,
            ruleName: rule.name
          });
        }
      }
    }
  }

  return {
    action: isModified ? 'modified' : 'allow',
    tool: currentTool,
    logs
  };
}

/**
 * Compiles and returns all Injected synthetic tools for the current origin.
 * 
 * @param {Array} originGroups 
 * @param {string} currentOrigin 
 * @returns {Array} Array of synthesized tool objects with bound execute handlers.
 */
export function getInjectedToolsForOrigin(originGroups, currentOrigin) {
  const injectedTools = [];

  const matchingGroups = (originGroups || []).filter(group => {
    if (group.disabled) return false;
    return matchOrigin(currentOrigin, group.originPattern);
  });

  for (const group of matchingGroups) {
    const activeRules = (group.rules || []).filter(r => !r.disabled && r.actionType === 'inject');

    for (const rule of activeRules) {
      if (!rule.injectedTool || !rule.injectedTool.name) continue;

      const def = rule.injectedTool;
      let executeFn;

      if (def.handlerType === 'js_script' && def.customScript) {
        try {
          // Compile JS function string safely in context
          const compiled = new Function(`return (${def.customScript});`)();
          if (typeof compiled === 'function') {
            executeFn = compiled;
          } else {
            executeFn = async (args) => compiled;
          }
        } catch (e) {
          console.error(`[WebMCP Engine] Error compiling script for injected tool '${def.name}':`, e);
          executeFn = async (args) => ({ error: `Compilation error in injected tool ${def.name}` });
        }
      } else {
        executeFn = async (args) => def.mockResponse || { status: 'ok', tool: def.name };
      }

      injectedTools.push({
        name: def.name,
        description: def.description || '',
        parameters: def.inputSchema || { type: 'object' },
        inputSchema: def.inputSchema || { type: 'object' },
        execute: executeFn,
        __isInjectedByExtension: true,
        groupId: group.id,
        ruleId: rule.id
      });
    }
  }

  return injectedTools;
}
