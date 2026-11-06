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
 * WebMCP MAIN World Interceptor (Runs at document_start in page context)
 *
 * Replaces/wraps navigator.modelContext, document.modelContext, window.webmcp, navigator.clientTools, navigator.ai
 * Intercepts tool registration, block/rename/rewrite, and injects synthetic tools.
 */

(function () {
  'use strict';

  if (window.__WEBMCP_INTERCEPTOR_INITIALIZED__) {
    return;
  }
  window.__WEBMCP_INTERCEPTOR_INITIALIZED__ = true;

  // Active state
  let activeOriginGroups = [];
  const registeredToolsMap = new Map();
  const toolAliases = new Map();
  let onToolChangeHandler = null;
  let rulesLoaded = false;
  const queuedRegistrations = [];

  // Preserve native Function.prototype.toString appearance ("[native code]")
  // for sites that verify Function.prototype.toString.call(f.registerTool).
  const nativeFunctionStrings = new WeakMap();
  const origFunctionToString = Function.prototype.toString;

  function markAsNative(fn, name) {
    if (typeof fn !== 'function') return fn;
    try {
      Object.defineProperty(fn, 'name', { value: name, configurable: true });
    } catch {
      /* ignore */
    }
    nativeFunctionStrings.set(fn, `function ${name}() { [native code] }`);
    return fn;
  }

  const wrappedFunctionToString = function toString() {
    if (nativeFunctionStrings.has(this)) {
      return nativeFunctionStrings.get(this);
    }
    return origFunctionToString.call(this);
  };
  markAsNative(wrappedFunctionToString, 'toString');
  try {
    Object.defineProperty(Function.prototype, 'toString', {
      value: wrappedFunctionToString,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch {
    Function.prototype.toString = wrappedFunctionToString;
  }

  const origModelContextRegisterTool =
    (window.ModelContext &&
      window.ModelContext.prototype &&
      window.ModelContext.prototype.registerTool) ||
    null;

  function invokeNativeRegisterTool(nativeTarget, tool, options) {
    const target =
      (nativeTarget && nativeTarget.__native_target__) || nativeTarget || nativeModelContext;
    if (!target || !tool) return;
    const cleanTool = {
      name: String(tool.name),
      description: String(tool.description || ''),
      inputSchema: tool.inputSchema || tool.parameters || { type: 'object', properties: {} },
      execute: tool.execute || tool.handler || tool.call || (async () => ({})),
    };
    const fn = origModelContextRegisterTool || target.registerTool;
    if (typeof fn === 'function') {
      try {
        if (options !== undefined) {
          return fn.call(target, cleanTool, options);
        }
        return fn.call(target, cleanTool);
      } catch {
        /* ignore */
      }
    }
  }

  function flushQueuedRegistrations() {
    while (queuedRegistrations.length > 0) {
      const q = queuedRegistrations.shift();
      if (q.type === 'proxy') {
        const res = registerSingleTool(q.args[0], q.args[1]);
        if (res !== false) {
          if (Array.isArray(res)) {
            res.forEach((t) => invokeNativeRegisterTool(q.target, t, q.args[1]));
          } else {
            invokeNativeRegisterTool(q.target, res, q.args[1]);
          }
        }
      } else if (q.type === 'prototype') {
        const res = registerSingleTool(q.args[0], q.args[1]);
        if (res !== false) {
          invokeNativeRegisterTool(q.thisObj, res, q.args[1]);
        }
      } else if (q.type === 'event') {
        const res = registerSingleTool(q.event.detail);
        if (res !== false) {
          originalDispatchEvent.apply(q.thisObj, [q.event]);
        }
      }
    }
  }

  // 1. Synchronously load cached rules from sessionStorage to prevent refresh race conditions
  function loadCachedRulesSynchronously() {
    try {
      const cached = sessionStorage.getItem('__WEBMCP_RULES_CACHE__');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) {
          activeOriginGroups = parsed;
          rulesLoaded = true;
        }
      }
    } catch {
      /* ignore */
    }
  }
  loadCachedRulesSynchronously();

  function safeGetHostProperty(hostObj, propName) {
    if (!hostObj) return null;
    try {
      let proto = hostObj;
      while (proto) {
        const desc = Object.getOwnPropertyDescriptor(proto, propName);
        if (desc) {
          if (typeof desc.get === 'function') {
            return desc.get.call(hostObj) || null;
          }
          if ('value' in desc) {
            return desc.value || null;
          }
        }
        proto = Object.getPrototypeOf(proto);
      }
      return hostObj[propName] || null;
    } catch {
      return null;
    }
  }

  const nativeModelContext =
    safeGetHostProperty(document, 'modelContext') ||
    safeGetHostProperty(window.navigator, 'modelContext') ||
    null;

  // --- Pattern Matcher & Evaluator Primitives ---
  function globToRegex(pattern) {
    if (!pattern || pattern === '*' || pattern === '*://*/*') {
      return /^.*$/;
    }
    let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    let regexString = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${regexString}$`, 'i');
  }

  function matchOrigin(targetUrl, pattern) {
    if (!pattern || pattern === '*' || pattern === '*://*/*') return true;
    if (!targetUrl) return false;
    try {
      let urlStr = targetUrl;
      if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
        urlStr = `http://${urlStr}`;
      }
      let normalizedPattern = pattern.trim();
      if (!normalizedPattern.includes('://')) {
        normalizedPattern = `*://${normalizedPattern}`;
      }
      if (!normalizedPattern.endsWith('*')) {
        if (normalizedPattern.endsWith('/')) {
          normalizedPattern = `${normalizedPattern}*`;
        } else {
          normalizedPattern = `${normalizedPattern}/*`;
        }
      }
      const regex = globToRegex(normalizedPattern);
      const urlObj = new URL(urlStr);
      const originRootStr = `${urlObj.protocol}//${urlObj.host}/`;
      return regex.test(urlStr) || regex.test(`${urlStr}/`) || regex.test(originRootStr);
    } catch {
      return globToRegex(pattern).test(targetUrl);
    }
  }

  function matchToolName(toolName, targetPattern, isRegex) {
    if (!toolName || !targetPattern) return false;
    if (targetPattern === '*') return true;
    if (isRegex) {
      try {
        return new RegExp(targetPattern, 'i').test(toolName);
      } catch {
        return false;
      }
    }
    if (targetPattern.includes('*')) {
      return globToRegex(targetPattern).test(toolName);
    }
    return toolName.toLowerCase() === targetPattern.toLowerCase();
  }

  function evaluateTool(tool, originGroups, currentUrl) {
    if (!tool || typeof tool !== 'object' || !tool.name) {
      return { action: 'allow', tool, logs: [] };
    }

    let currentTool = {
      ...tool,
      name: String(tool.name),
      description: tool.description ? String(tool.description) : '',
    };
    delete currentTool.window;

    const logs = [];
    let isModified = false;

    const matchingGroups = (originGroups || []).filter((group) => {
      if (group.disabled) return false;
      return matchOrigin(currentUrl, group.originPattern);
    });

    for (const group of matchingGroups) {
      const activeRules = (group.rules || []).filter((r) => !r.disabled);

      for (const rule of activeRules) {
        if (rule.actionType === 'inject') continue;

        if (matchToolName(currentTool.name, rule.targetToolName, rule.isRegexPattern)) {
          if (rule.actionType === 'block') {
            logs.push({
              actionTaken: 'blocked',
              originalToolName: tool.name,
              originalDescription: tool.description,
              groupId: group.id,
              groupName: group.name,
              ruleId: rule.id,
              ruleName: rule.name,
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
              ruleName: rule.name,
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
                currentTool.description = currentTool.description.replace(
                  rx,
                  config.replacement || '',
                );
              } catch {
                /* ignore */
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
              ruleName: rule.name,
            });
          }

          if (rule.actionType === 'rewrite_param_desc' && rule.targetParam && rule.rewriteConfig) {
            if (
              currentTool.inputSchema &&
              currentTool.inputSchema.properties &&
              currentTool.inputSchema.properties[rule.targetParam]
            ) {
              if (!currentTool.__schemaCloned) {
                currentTool.inputSchema = JSON.parse(JSON.stringify(currentTool.inputSchema));
                currentTool.__schemaCloned = true;
              }
              const param = currentTool.inputSchema.properties[rule.targetParam];
              const prevDesc = param.description || '';
              const config = rule.rewriteConfig;

              if (config.mode === 'static') {
                param.description = config.replacement || '';
              } else if (config.mode === 'prepend') {
                param.description = (config.replacement || '') + prevDesc;
              } else if (config.mode === 'append') {
                param.description = prevDesc + (config.replacement || '');
              } else if (config.mode === 'regex_replace' && config.pattern) {
                try {
                  const rx = new RegExp(config.pattern, 'g');
                  param.description = prevDesc.replace(rx, config.replacement || '');
                } catch {
                  /* ignore */
                }
              }

              isModified = true;
              logs.push({
                actionTaken: 'param_desc_rewritten',
                originalToolName: tool.name,
                targetParam: rule.targetParam,
                groupId: group.id,
                groupName: group.name,
                ruleId: rule.id,
                ruleName: rule.name,
              });
            }
          }

          if (rule.actionType === 'rename_param' && rule.targetParam && rule.renameTo) {
            if (
              currentTool.inputSchema &&
              currentTool.inputSchema.properties &&
              currentTool.inputSchema.properties[rule.targetParam]
            ) {
              if (!currentTool.__schemaCloned) {
                currentTool.inputSchema = JSON.parse(JSON.stringify(currentTool.inputSchema));
                currentTool.__schemaCloned = true;
              }
              const schema = currentTool.inputSchema;
              schema.properties[rule.renameTo] = schema.properties[rule.targetParam];
              delete schema.properties[rule.targetParam];

              if (Array.isArray(schema.required)) {
                const idx = schema.required.indexOf(rule.targetParam);
                if (idx !== -1) {
                  schema.required[idx] = rule.renameTo;
                }
              }

              const originalExecute =
                currentTool.execute || currentTool.handler || currentTool.call;
              if (typeof originalExecute === 'function') {
                const originalParam = rule.targetParam;
                const newParam = rule.renameTo;
                const wrappedExecute = async function (args) {
                  let callArgs = args;
                  if (args && typeof args === 'object' && args[newParam] !== undefined) {
                    callArgs = Object.assign({}, args);
                    callArgs[originalParam] = callArgs[newParam];
                    delete callArgs[newParam];
                  }
                  const restArgs = Array.prototype.slice.call(arguments, 1);
                  return originalExecute.apply(this, [callArgs, ...restArgs]);
                };
                if (currentTool.execute) currentTool.execute = wrappedExecute;
                if (currentTool.handler) currentTool.handler = wrappedExecute;
                if (currentTool.call) currentTool.call = wrappedExecute;
              }

              isModified = true;
              logs.push({
                actionTaken: 'param_renamed',
                originalToolName: tool.name,
                targetParam: rule.targetParam,
                renameTo: rule.renameTo,
                groupId: group.id,
                groupName: group.name,
                ruleId: rule.id,
                ruleName: rule.name,
              });
            }
          }
        }
      }
    }

    return {
      action: isModified ? 'modified' : 'allow',
      tool: currentTool,
      logs,
    };
  }

  function getInjectedTools(originGroups, currentUrl) {
    const injected = [];
    const matchingGroups = (originGroups || []).filter(
      (g) => !g.disabled && matchOrigin(currentUrl, g.originPattern),
    );

    for (const group of matchingGroups) {
      const activeRules = (group.rules || []).filter(
        (r) => !r.disabled && r.actionType === 'inject',
      );

      for (const rule of activeRules) {
        if (!rule.injectedTool || !rule.injectedTool.name) continue;
        const def = rule.injectedTool;
        let executeFn;

        if (def.handlerType === 'js_script' && def.customScript) {
          try {
            const compiled = new Function(`return (${def.customScript});`)();
            executeFn = typeof compiled === 'function' ? compiled : async (_args) => compiled;
          } catch {
            try {
              executeFn = new Function('args', `return (async () => { ${def.customScript} })();`);
            } catch (err) {
              console.error(`[WebMCP Interceptor] Error compiling script for '${def.name}':`, err);
              executeFn = async () => ({ error: `Script error in ${def.name}` });
            }
          }
        } else {
          executeFn = async () => def.mockResponse || { status: 'ok', tool: def.name };
        }

        injected.push({
          name: def.name,
          description: def.description || '',
          parameters: def.inputSchema || { type: 'object' },
          inputSchema: def.inputSchema || { type: 'object' },
          execute: executeFn,
          handler: executeFn,
          __isInjected: true,
          groupId: group.id,
          ruleId: rule.id,
        });
      }
    }
    return injected;
  }

  function notifyAudit(logs) {
    if (!logs || !logs.length) return;
    logs.forEach((log) => {
      window.dispatchEvent(
        new CustomEvent('__WEBMCP_AUDIT_LOG_EVENT__', {
          detail: { ...log, origin: window.location.href },
        }),
      );
    });
  }

  function notifyToolChangeEvent() {
    if (typeof onToolChangeHandler === 'function') {
      try {
        onToolChangeHandler();
      } catch {
        /* ignore */
      }
    }
    try {
      window.dispatchEvent(new CustomEvent('toolchange'));
      window.dispatchEvent(new CustomEvent('webmcp:tools-changed'));
    } catch {
      /* ignore */
    }
  }

  // Normalize polymorphic tool arguments:
  // 1. registerTool("toolName", { description, execute })
  // 2. registerTool({ name: "toolName", description })
  // 3. registerTool([ tool1, tool2 ])
  function normalizeToolInput(arg1, arg2) {
    if (Array.isArray(arg1)) {
      return arg1.map((item) => normalizeToolInput(item)).filter(Boolean);
    }
    if (typeof arg1 === 'string') {
      if (arg2 && typeof arg2 === 'object') {
        const copy = { ...arg2, name: arg1 };
        delete copy.window;
        return copy;
      }
      return { name: arg1 };
    }
    if (arg1 && typeof arg1 === 'object') {
      const copy = { ...arg1 };
      delete copy.window;
      return copy;
    }
    return null;
  }

  // Re-evaluate tools registered prior to storage sync loading
  function reEvaluateRegisteredTools() {
    if (registeredToolsMap.size === 0) return;

    const existingTools = Array.from(registeredToolsMap.values());
    registeredToolsMap.clear();
    toolAliases.clear();

    existingTools.forEach((tool) => {
      if (tool.__isInjected) {
        registeredToolsMap.set(tool.name, tool);
        return;
      }

      const evalResult = evaluateTool(tool, activeOriginGroups, window.location.href);
      notifyAudit(evalResult.logs);

      if (evalResult.action !== 'blocked' && evalResult.tool) {
        registeredToolsMap.set(evalResult.tool.name, evalResult.tool);
        if (evalResult.action === 'modified') {
          invokeNativeRegisterTool(nativeModelContext, evalResult.tool);
        }
      }
    });
  }

  function syncConfiguration(newOriginGroups) {
    rulesLoaded = true;
    if (!Array.isArray(newOriginGroups)) return;
    activeOriginGroups = newOriginGroups;
    try {
      sessionStorage.setItem('__WEBMCP_RULES_CACHE__', JSON.stringify(newOriginGroups));
    } catch {
      /* ignore */
    }

    reEvaluateRegisteredTools();
    flushQueuedRegistrations();
    applyInjectedTools();
  }

  function checkSynchronousAutomationConfig() {
    if (window.__WEBMCP_OVERRIDE_CONFIG__ && Array.isArray(window.__WEBMCP_OVERRIDE_CONFIG__)) {
      syncConfiguration(window.__WEBMCP_OVERRIDE_CONFIG__);
    }

    try {
      const urlParams = new URLSearchParams(window.location.search);
      const encodedRules = urlParams.get('webmcp_rules');
      if (encodedRules) {
        const decoded = JSON.parse(atob(encodedRules));
        if (Array.isArray(decoded)) {
          syncConfiguration(decoded);
        }
      }
    } catch {
      /* ignore */
    }
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'WEBMCP_SET_OVERRIDE_RULES') {
      if (Array.isArray(event.data.originGroups)) {
        syncConfiguration(event.data.originGroups);
      }
    }
  });

  window.addEventListener('__WEBMCP_STORAGE_UPDATE__', (event) => {
    if (event.detail && Array.isArray(event.detail.originGroups)) {
      syncConfiguration(event.detail.originGroups);
    }
  });

  checkSynchronousAutomationConfig();

  // --- Core WebMCP Registry Interceptor ---
  function applyInjectedTools() {
    const injected = getInjectedTools(activeOriginGroups, window.location.href);
    let addedCount = 0;

    injected.forEach((tool) => {
      if (!registeredToolsMap.has(tool.name)) {
        try {
          invokeNativeRegisterTool(nativeModelContext, tool);
        } catch (e) {
          console.error('[WebMCP Interceptor] Error registering injected tool natively:', e);
        }
        registeredToolsMap.set(tool.name, tool);
        addedCount++;

        notifyAudit([
          {
            actionTaken: 'injected',
            originalToolName: tool.name,
            finalToolName: tool.name,
            groupId: tool.groupId,
            ruleId: tool.ruleId,
          },
        ]);
      } else {
        registeredToolsMap.set(tool.name, tool);
      }
    });

    if (addedCount > 0) {
      notifyToolChangeEvent();
    }
  }

  // Multi-stage deferred injection to run post-page initialization
  applyInjectedTools();
  document.addEventListener('DOMContentLoaded', applyInjectedTools);
  window.addEventListener('load', applyInjectedTools);

  function processAndRegisterTool(toolInput) {
    const normalized = normalizeToolInput(toolInput);
    if (!normalized) return false;

    if (Array.isArray(normalized)) {
      return normalized.map((t) => processAndRegisterTool(t)).filter(Boolean);
    }

    const evalResult = evaluateTool(normalized, activeOriginGroups, window.location.href);
    notifyAudit(evalResult.logs);

    if (evalResult.action === 'blocked' || !evalResult.tool) {
      return false;
    }

    registeredToolsMap.set(evalResult.tool.name, evalResult.tool);

    if (normalized.name && normalized.name !== evalResult.tool.name) {
      toolAliases.set(normalized.name, evalResult.tool);
    }

    notifyToolChangeEvent();
    return evalResult.tool;
  }

  function registerSingleTool(arg1, arg2) {
    const normalized = normalizeToolInput(arg1, arg2);
    if (!normalized) return false;

    if (Array.isArray(normalized)) {
      return normalized.map((t) => processAndRegisterTool(t)).filter(Boolean);
    }

    return processAndRegisterTool(normalized);
  }

  // Create Intercepting Proxy Interface wrapper around any object
  function createInterceptorProxy(targetObj) {
    const actualTarget = targetObj || nativeModelContext || {};
    const methodCache = new Map();

    function getCachedMethod(name, factory) {
      if (!methodCache.has(name)) {
        const fn = markAsNative(factory(), name);
        methodCache.set(name, fn);
      }
      return methodCache.get(name);
    }

    return new Proxy(actualTarget, {
      get(target, prop) {
        if (prop === '__native_target__') return target;
        if (
          prop === 'registerTool' ||
          prop === 'registerTools' ||
          prop === 'addTool' ||
          prop === 'register'
        ) {
          return getCachedMethod(String(prop), () => function (...args) {
            if (!rulesLoaded) {
              queuedRegistrations.push({ type: 'proxy', target, prop, args });
              return args[0];
            }
            const res = registerSingleTool(args[0], args[1]);
            if (res !== false) {
              if (Array.isArray(res)) {
                res.forEach((t) => invokeNativeRegisterTool(target, t, args[1]));
              } else {
                invokeNativeRegisterTool(target, res, args[1]);
              }
            }
            return res;
          });
        }
        if (prop === 'provideTools' || prop === 'provideContext') {
          return getCachedMethod(String(prop), () => function (arg) {
            const toolsArray = Array.isArray(arg)
              ? arg
              : arg && Array.isArray(arg.tools)
                ? arg.tools
                : [];
            if (!rulesLoaded) {
              queuedRegistrations.push({
                type: 'proxy',
                target,
                prop: 'registerTools',
                args: [toolsArray],
              });
              return toolsArray;
            }
            const processed = registerSingleTool(toolsArray);
            const list = Array.isArray(processed) ? processed : processed ? [processed] : [];
            list.forEach((t) => invokeNativeRegisterTool(target, t));
            return list;
          });
        }
        if (prop === 'getTools') {
          return getCachedMethod('getTools', () => function () {
            applyInjectedTools();
            return Array.from(registeredToolsMap.values());
          });
        }
        if (prop === 'executeTool') {
          return getCachedMethod('executeTool', () => async function (toolObj, inputArgs) {
            const toolName = typeof toolObj === 'string' ? toolObj : toolObj && toolObj.name;
            const tool = registeredToolsMap.get(toolName) || toolAliases.get(toolName);
            if (tool) {
              const fn = tool.execute || tool.handler || tool.call;
              if (typeof fn === 'function') {
                return fn(inputArgs);
              }
            }
            throw new Error(`Tool "${toolName}" not found or not executable`);
          });
        }
        if (prop === 'tools') {
          applyInjectedTools();
          return Array.from(registeredToolsMap.values());
        }
        if (prop === 'ontoolchange') {
          return onToolChangeHandler;
        }
        const val = Reflect.get(target, prop, target);
        if (typeof val === 'function') {
          return getCachedMethod(String(prop), () => val.bind(target));
        }
        return val;
      },
      set(target, prop, value) {
        if (prop === 'ontoolchange') {
          onToolChangeHandler = value;
          return true;
        }
        if (prop === 'tools' && Array.isArray(value)) {
          const injectedTools = Array.from(registeredToolsMap.values()).filter(
            (t) => t.__isInjected,
          );
          registeredToolsMap.clear();
          toolAliases.clear();
          injectedTools.forEach((t) => registeredToolsMap.set(t.name, t));

          value.forEach((t) => registerSingleTool(t));
          applyInjectedTools();
          return true;
        }
        return Reflect.set(target, prop, value, target);
      },
    });
  }

  // Getter/Setter Trap definition for global objects
  function bindGlobalPropertyTrap(hostObj, propName) {
    if (!hostObj) return;

    const targetVal = safeGetHostProperty(hostObj, propName) || nativeModelContext || {};
    let currentVal = createInterceptorProxy(targetVal);

    try {
      Object.defineProperty(hostObj, propName, {
        get() {
          return currentVal;
        },
        set(newVal) {
          if (newVal && typeof newVal === 'object') {
            currentVal = createInterceptorProxy(newVal);
          } else {
            currentVal = newVal;
          }
        },
        configurable: true,
        enumerable: false,
      });
    } catch {
      hostObj[propName] = currentVal;
    }
  }

  // Bind traps across standard WebMCP global targets
  bindGlobalPropertyTrap(document, 'modelContext');
  bindGlobalPropertyTrap(window.navigator, 'modelContext');
  bindGlobalPropertyTrap(window.navigator, 'clientTools');
  bindGlobalPropertyTrap(window, 'modelContext');
  bindGlobalPropertyTrap(window, 'webmcp');

  if (window.navigator.ai) {
    bindGlobalPropertyTrap(window.navigator.ai, 'tools');
  }

  // Trap native C++ ModelContext prototype methods if exposed natively
  if (window.ModelContext && window.ModelContext.prototype) {
    try {
      const origRegisterTool = window.ModelContext.prototype.registerTool;
      window.ModelContext.prototype.__origRegisterTool = origRegisterTool;
      window.ModelContext.prototype.registerTool = markAsNative(function registerTool(...args) {
        if (!rulesLoaded) {
          queuedRegistrations.push({ type: 'prototype', thisObj: this, args, origRegisterTool });
          return args[0];
        }
        const res = registerSingleTool(args[0], args[1]);
        if (res === false) {
          return false;
        }
        if (origRegisterTool) {
          const target = (this && this.__native_target__) || this;
          return invokeNativeRegisterTool(target, res, args[1]);
        }
        return res;
      }, 'registerTool');

      Object.defineProperty(window.ModelContext.prototype, 'tools', {
        get() {
          applyInjectedTools();
          return Array.from(registeredToolsMap.values());
        },
        configurable: true,
        enumerable: false,
      });
    } catch {
      /* ignore */
    }
  }

  // Intercept CustomEvent registrations
  const originalDispatchEvent = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = markAsNative(function dispatchEvent(event) {
    if (event && event.type) {
      const typeLower = event.type.toLowerCase();
      if (
        typeLower === 'webmcp:register' ||
        typeLower === 'modelcontext:register' ||
        typeLower === 'registertool' ||
        typeLower === 'webmcp:registertool' ||
        typeLower === 'mcp:register'
      ) {
        if (event.detail) {
          if (!rulesLoaded) {
            queuedRegistrations.push({ type: 'event', event, thisObj: this });
            return false;
          }
          const result = registerSingleTool(event.detail);
          if (!result) {
            return false; // Blocked
          }
        }
      }
    }
    return originalDispatchEvent.apply(this, arguments);
  }, 'dispatchEvent');

  setTimeout(() => {
    if (!rulesLoaded) {
      rulesLoaded = true;
      flushQueuedRegistrations();
    }
  }, 500);
})();
