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
 * Default Preset Origin Groups
 */

export const DEFAULT_ORIGIN_GROUPS = [
  {
    id: "preset-global-defaults",
    name: "Global Default Overrides",
    originPattern: "*://*/*",
    disabled: false,
    rules: [
      {
        id: "preset-rule-sample-block",
        name: "Block Telemetry & Tracking Tools",
        actionType: "block",
        targetToolName: "*telemetry*",
        isRegexPattern: false,
        disabled: true
      },
      {
        id: "preset-rule-sample-rename",
        name: "Standardize Search Action Name",
        actionType: "rename",
        targetToolName: "search_catalog",
        renameTo: "query_items",
        disabled: true
      }
    ],
    createdAt: Date.now(),
    updatedAt: Date.now()
  },
  {
    id: "preset-e2e-testing",
    name: "E2E Testing & Automation Sandbox",
    originPattern: "http://localhost:*/*",
    disabled: false,
    rules: [
      {
        id: "preset-rule-synthetic-helper",
        name: "Inject Synthetic Automation Helper Tool",
        actionType: "inject",
        disabled: false,
        injectedTool: {
          name: "synthetic_automation_helper",
          description: "Synthetic test tool injected for automation pipelines",
          inputSchema: {
            type: "object",
            properties: {
              action: { type: "string" },
              payload: { type: "object" }
            }
          },
          handlerType: "js_script",
          customScript: "(args) => ({ status: 'success', mockExecuted: true, receivedArgs: args, timestamp: Date.now() })"
        }
      }
    ],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
];

export const DEFAULT_SETTINGS = {
  globalDisabled: false,
  logInterceptions: true,
  maxLogEntries: 200,
  automationServerEnabled: false,
  automationServerUrl: "http://127.0.0.1:8999/webmcp-rules.json"
};
