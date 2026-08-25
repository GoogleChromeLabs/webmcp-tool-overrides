# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import pytest
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
import os
import json
import threading
import time
import re
from http.server import BaseHTTPRequestHandler, HTTPServer

# Shared state for the HTTP Server
mock_rules = []

class MockServerRequestHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/webmcp-rules.json':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
            self.end_headers()
            self.wfile.write(json.dumps(mock_rules).encode('utf-8'))
            return
        self.send_response(404)
        self.end_headers()
        
    def log_message(self, format, *args):
        pass # Suppress logs to keep pytest output clean

@pytest.fixture(scope="session")
def mock_server():
    server = HTTPServer(('127.0.0.1', 8999), MockServerRequestHandler)
    thread = threading.Thread(target=server.serve_forever)
    thread.daemon = True
    thread.start()
    yield server
    server.shutdown()

@pytest.fixture(scope="session")
def driver():
    chrome_options = Options()
    extension_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    
    chrome_options.add_argument(f"--disable-extensions-except={extension_path}")
    chrome_options.add_argument(f"--load-extension={extension_path}")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    if os.environ.get('CI'):
        chrome_options.add_argument("--headless=new")
    
    service = Service(service_args=['--verbose'], log_output='chromedriver.log')
    driver = webdriver.Chrome(service=service, options=chrome_options)
    
    time.sleep(2)
    
    driver.get('chrome://system')
    time.sleep(1)
    
    try:
        btn = driver.find_element("id", "extensions-value-btn")
        btn.click()
        time.sleep(0.5)
    except:
        pass
        
    page_text = driver.execute_script("return document.body.innerText;")
    
    match = re.search(r'WebMCP Tool Override.*?([a-z]{32})', page_text, re.IGNORECASE)
    if match:
        extension_id = match.group(1)
    else:
        driver.get('chrome://extensions-internals')
        time.sleep(1)
        page_text = driver.execute_script("return document.body.innerText;")
        match = re.search(r'"name":\s*"WebMCP Tool Override",[\s\S]*?"id":\s*"([a-z]{32})"', page_text, re.IGNORECASE)
        if match:
            extension_id = match.group(1)
        else:
            print("Extensions internals text:", page_text)
            pytest.skip("Could not find loaded extension ID due to restricted environment")
            
    driver.get(f"chrome-extension://{extension_id}/dashboard/dashboard.html")
    
    driver.execute_script("""
        chrome.storage.local.set({
            'webmcp_settings': {
                'automationServerEnabled': true,
                'automationServerUrl': 'http://127.0.0.1:8999/webmcp-rules.json'
            }
        });
    """)
    
    time.sleep(2)
    
    yield driver
    driver.quit()

@pytest.fixture(autouse=True)
def reset_rules():
    global mock_rules
    mock_rules = []

def set_groups(groups):
    global mock_rules
    mock_rules = groups
    time.sleep(5.5)

def set_rules(rules):
    set_groups([{
        "name": "Test Group",
        "originPattern": "*",
        "disabled": False,
        "rules": rules
    }])

def get_tools_from_page(driver):
    return driver.execute_script("""
        return typeof window.webmcp.getTools === 'function' ? window.webmcp.getTools() : window.webmcp.tools;
    """)

def test_block_rule(driver, mock_server):
    set_rules([{
        "actionType": "block",
        "targetToolName": "dangerous_action"
    }])
    
    driver.get("data:text/html,<html><body><h1>Test Page</h1></body></html>")
    
    driver.execute_script("""
        window.webmcp.registerTool({ name: 'dangerous_action', description: 'Blocked' });
        window.webmcp.registerTool({ name: 'safe_action', description: 'Allowed' });
    """)
    
    tools = get_tools_from_page(driver)
    tool_names = [t['name'] for t in tools]
    
    assert "dangerous_action" not in tool_names
    assert "safe_action" in tool_names

def test_rename_rewrite_rule(driver, mock_server):
    set_rules([
        {
            "actionType": "rename",
            "targetToolName": "search_items",
            "renameTo": "query_inventory"
        },
        {
            "actionType": "rewrite",
            "targetToolName": "checkout",
            "rewriteConfig": {
                "mode": "append",
                "replacement": " [TEST MODE]"
            }
        }
    ])
    
    driver.get("data:text/html,<html><body><h1>Test Page</h1></body></html>")
    
    driver.execute_script("""
        window.webmcp.registerTool({ name: 'search_items', description: 'Search the catalog' });
        window.webmcp.registerTool({ name: 'checkout', description: 'Proceed to checkout' });
    """)
    
    tools = get_tools_from_page(driver)
    tool_names = [t['name'] for t in tools]
    
    assert "query_inventory" in tool_names
    assert "search_items" not in tool_names
    
    checkout_tool = next((t for t in tools if t['name'] == 'checkout'), None)
    assert checkout_tool is not None
    assert checkout_tool['description'] == 'Proceed to checkout [TEST MODE]'

def test_inject_rule(driver, mock_server):
    set_rules([
        {
            "actionType": "inject",
            "injectedTool": {
                "name": "synthetic_helper",
                "description": "Injected tool",
                "handlerType": "js_script",
                "customScript": "(args) => ({ ok: true, data: args.val })"
            }
        }
    ])
    
    driver.get("data:text/html,<html><body><h1>Test Page</h1></body></html>")
    
    tools = get_tools_from_page(driver)
    tool_names = [t['name'] for t in tools]
    
    assert "synthetic_helper" in tool_names
    
    injected = next((t for t in tools if t['name'] == 'synthetic_helper'), None)
    assert injected is not None
    assert injected['description'] == 'Injected tool'
    
    result = driver.execute_async_script("""
        var done = arguments[arguments.length - 1];
        window.webmcp.executeTool('synthetic_helper', { val: 42 }).then(res => done(res));
    """)
    
    assert result == {"ok": True, "data": 42}

def test_cross_origin_isolation(driver, mock_server):
    set_groups([
        {
            "name": "Example Rules",
            "originPattern": "*://example.com/*",
            "disabled": False,
            "rules": [
                {
                    "actionType": "block",
                    "targetToolName": "only_blocked_on_example"
                }
            ]
        },
        {
            "name": "Test Rules",
            "originPattern": "*://test.com/*",
            "disabled": False,
            "rules": [
                {
                    "actionType": "rename",
                    "targetToolName": "only_renamed_on_test",
                    "renameTo": "renamed_success"
                }
            ]
        }
    ])
    
    # 1. Test example.com (Block rule should apply, rename rule should NOT apply)
    driver.get("http://example.com/")
    driver.execute_script("""
        window.webmcp = window.webmcp || {};
        window.webmcp.registerTool({ name: 'only_blocked_on_example', description: 'desc' });
        window.webmcp.registerTool({ name: 'only_renamed_on_test', description: 'desc' });
    """)
    tools = get_tools_from_page(driver)
    tool_names = [t['name'] for t in tools]
    
    assert "only_blocked_on_example" not in tool_names
    assert "only_renamed_on_test" in tool_names
    assert "renamed_success" not in tool_names
    
    # 2. Test test.com (Rename rule should apply, block rule should NOT apply)
    driver.get("http://test.com/")
    driver.execute_script("""
        window.webmcp = window.webmcp || {};
        window.webmcp.registerTool({ name: 'only_blocked_on_example', description: 'desc' });
        window.webmcp.registerTool({ name: 'only_renamed_on_test', description: 'desc' });
    """)
    tools = get_tools_from_page(driver)
    tool_names = [t['name'] for t in tools]
    
    assert "only_blocked_on_example" in tool_names
    assert "only_renamed_on_test" not in tool_names
    assert "renamed_success" in tool_names


def test_rewrite_modes(driver, mock_server):
    set_groups([{
        "name": "Rewrite Modes Test",
        "originPattern": "*",
        "disabled": False,
        "rules": [
            {
                "actionType": "rewrite",
                "targetToolName": "tool_static",
                "rewriteConfig": { "mode": "static", "replacement": "Completely new" }
            },
            {
                "actionType": "rewrite",
                "targetToolName": "tool_prepend",
                "rewriteConfig": { "mode": "prepend", "replacement": "[PRE] " }
            },
            {
                "actionType": "rewrite",
                "targetToolName": "tool_append",
                "rewriteConfig": { "mode": "append", "replacement": " [APP]" }
            },
            {
                "actionType": "rewrite",
                "targetToolName": "tool_regex",
                "rewriteConfig": { "mode": "regex_replace", "pattern": "blue", "replacement": "red" }
            }
        ]
    }])
    
    driver.get("data:text/html,<html><body><h1>Rewrite Modes</h1></body></html>")
    driver.execute_script("""
        window.webmcp = window.webmcp || {};
        window.webmcp.registerTool({ name: 'tool_static', description: 'Old desc' });
        window.webmcp.registerTool({ name: 'tool_prepend', description: 'Desc' });
        window.webmcp.registerTool({ name: 'tool_append', description: 'Desc' });
        window.webmcp.registerTool({ name: 'tool_regex', description: 'The blue car is blue' });
    """)
    
    tools = get_tools_from_page(driver)
    
    t_static = next((t for t in tools if t['name'] == 'tool_static'), None)
    assert t_static['description'] == "Completely new"
    
    t_prepend = next((t for t in tools if t['name'] == 'tool_prepend'), None)
    assert t_prepend['description'] == "[PRE] Desc"
    
    t_append = next((t for t in tools if t['name'] == 'tool_append'), None)
    assert t_append['description'] == "Desc [APP]"
    
    t_regex = next((t for t in tools if t['name'] == 'tool_regex'), None)
    assert t_regex['description'] == "The red car is red"

def test_rename_execution_routing(driver, mock_server):
    set_rules([
        {
            "actionType": "rename",
            "targetToolName": "original_name",
            "renameTo": "new_name"
        }
    ])
    
    driver.get("data:text/html,<html><body><h1>Routing</h1></body></html>")
    driver.execute_script("""
        window.webmcp = window.webmcp || {};
        // Mock the original execution returning a specific payload
        window.webmcp.registerTool({ 
            name: 'original_name', 
            description: 'desc',
            execute: async (args) => ({ success: true, originalCalled: true })
        });
    """)
    
    tools = get_tools_from_page(driver)
    tool_names = [t['name'] for t in tools]
    
    assert "new_name" in tool_names
    assert "original_name" not in tool_names
    
    # Assert executing new_name works and routes correctly
    result_new = driver.execute_async_script("""
        var done = arguments[arguments.length - 1];
        window.webmcp.executeTool('new_name', {}).then(res => done(res)).catch(e => done({error: e.toString()}));
    """)
    assert result_new.get("success") is True
    assert result_new.get("originalCalled") is True
    
    # Assert old tool calls don't work!
    result_old = driver.execute_async_script("""
        var done = arguments[arguments.length - 1];
        window.webmcp.executeTool('original_name', {}).then(res => done(res)).catch(e => done({error: "Not Found"}));
    """)
    assert result_old.get("error") == "Not Found"

def test_tool_name_pattern_matching(driver, mock_server):
    set_rules([
        {
            "actionType": "block",
            "targetToolName": "search_*",
            "isRegexPattern": False
        },
        {
            "actionType": "block",
            "targetToolName": "^get_[a-z]+$",
            "isRegexPattern": True
        }
    ])
    
    driver.get("data:text/html,<html><body><h1>Pattern Matching</h1></body></html>")
    driver.execute_script("""
        window.webmcp = window.webmcp || {};
        window.webmcp.registerTool({ name: 'search_catalog', description: '' });
        window.webmcp.registerTool({ name: 'search_users', description: '' });
        window.webmcp.registerTool({ name: 'searchItem', description: 'No underscore' });
        
        window.webmcp.registerTool({ name: 'get_items', description: '' });
        window.webmcp.registerTool({ name: 'get_123', description: 'Numbers not in regex' });
    """)
    
    tools = get_tools_from_page(driver)
    tool_names = [t['name'] for t in tools]
    
    assert "search_catalog" not in tool_names
    assert "search_users" not in tool_names
    assert "searchItem" in tool_names # Did not match glob
    
    assert "get_items" not in tool_names
    assert "get_123" in tool_names # Did not match regex


def test_disabled_states(driver, mock_server):
    set_groups([{
        "name": "Disabled Group",
        "originPattern": "*",
        "disabled": True,
        "rules": [
            { "actionType": "block", "targetToolName": "should_be_allowed_1" }
        ]
    }, {
        "name": "Active Group with Disabled Rule",
        "originPattern": "*",
        "disabled": False,
        "rules": [
            { "actionType": "block", "targetToolName": "should_be_allowed_2", "disabled": True },
            { "actionType": "block", "targetToolName": "should_be_blocked", "disabled": False }
        ]
    }])
    
    driver.get("data:text/html,<html><body><h1>Disabled States</h1></body></html>")
    driver.execute_script("""
        window.webmcp = window.webmcp || {};
        window.webmcp.registerTool({ name: 'should_be_allowed_1', description: '' });
        window.webmcp.registerTool({ name: 'should_be_allowed_2', description: '' });
        window.webmcp.registerTool({ name: 'should_be_blocked', description: '' });
    """)
    
    tools = get_tools_from_page(driver)
    tool_names = [t['name'] for t in tools]
    
    assert "should_be_allowed_1" in tool_names
    assert "should_be_allowed_2" in tool_names
    assert "should_be_blocked" not in tool_names

def test_global_disable(driver, mock_server):
    # Enable global disable via storage
    driver.execute_script("""
        chrome.storage.local.get(['webmcp_settings'], (res) => {
            let s = res.webmcp_settings || {};
            s.globalDisabled = true;
            chrome.storage.local.set({ webmcp_settings: s });
        });
    """)
    time.sleep(1) # Wait for storage to propagate
    
    set_rules([
        { "actionType": "block", "targetToolName": "blocked_tool" }
    ])
    
    driver.get("data:text/html,<html><body><h1>Global Disable</h1></body></html>")
    driver.execute_script("""
        window.webmcp = window.webmcp || {};
        window.webmcp.registerTool({ name: 'blocked_tool', description: '' });
    """)
    
    tools = get_tools_from_page(driver)
    tool_names = [t['name'] for t in tools]
    assert "blocked_tool" in tool_names # Should be allowed because globally disabled
    
    # Restore
    driver.execute_script("""
        chrome.storage.local.get(['webmcp_settings'], (res) => {
            let s = res.webmcp_settings || {};
            s.globalDisabled = false;
            chrome.storage.local.set({ webmcp_settings: s });
        });
    """)
    time.sleep(1)

def test_navigator_api_interception(driver, mock_server):
    set_rules([
        { "actionType": "block", "targetToolName": "blocked_by_clientTools" },
        { "actionType": "block", "targetToolName": "blocked_by_modelContext" }
    ])
    
    driver.get("data:text/html,<html><body><h1>Navigator APIs</h1></body></html>")
    
    driver.execute_script("""
        // 1. clientTools
        window.navigator.clientTools = window.navigator.clientTools || [];
        window.navigator.clientTools.push({ name: 'blocked_by_clientTools' });
        window.navigator.clientTools.push({ name: 'allowed_1' });
        
        // 2. modelContext
        window.navigator.modelContext = window.navigator.modelContext || {};
        window.navigator.modelContext.tools = window.navigator.modelContext.tools || [];
        window.navigator.modelContext.tools.push({ name: 'blocked_by_modelContext' });
        window.navigator.modelContext.tools.push({ name: 'allowed_2' });
    """)
    
    # Read the intercepted arrays
    client_tools = driver.execute_script("return window.navigator.clientTools;")
    ct_names = [t['name'] for t in client_tools] if client_tools else []
    
    assert "blocked_by_clientTools" not in ct_names
    assert "allowed_1" in ct_names
    
    model_ctx_tools = driver.execute_script("return window.navigator.modelContext.tools;")
    mc_names = [t['name'] for t in model_ctx_tools] if model_ctx_tools else []
    
    assert "blocked_by_modelContext" not in mc_names
    assert "allowed_2" in mc_names

def test_dynamic_polling_updates(driver, mock_server):
    set_rules([
        { "actionType": "block", "targetToolName": "dynamic_target" }
    ])
    
    driver.get("data:text/html,<html><body><h1>Polling</h1></body></html>")
    driver.execute_script("""
        window.webmcp = window.webmcp || {};
        window.webmcp.registerTool({ name: 'dynamic_target', description: '' });
    """)
    
    tools = get_tools_from_page(driver)
    assert "dynamic_target" not in [t['name'] for t in tools]
    
    # Change rules WITHOUT refreshing the page
    set_rules([
        { "actionType": "rename", "targetToolName": "dynamic_target", "renameTo": "dynamic_renamed" }
    ])
    
    # Register the tool again on the SAME page instance
    driver.execute_script("""
        window.webmcp.registerTool({ name: 'dynamic_target', description: '' });
    """)
    
    tools2 = get_tools_from_page(driver)
    names2 = [t['name'] for t in tools2]
    
    # Verify the new rule applied instantly without a page refresh!
    assert "dynamic_target" not in names2
    assert "dynamic_renamed" in names2

def test_audit_logging(driver, mock_server):
    driver.execute_script("""
        chrome.storage.local.get(['webmcp_settings'], (res) => {
            let s = res.webmcp_settings || {};
            s.logInterceptions = true;
            chrome.storage.local.set({ webmcp_settings: s });
        });
        // Clear logs
        chrome.storage.local.set({ webmcp_interception_logs: [] });
    """)
    time.sleep(1)
    
    set_rules([
        { "actionType": "block", "targetToolName": "logged_blocked_tool" }
    ])
    
    driver.get("data:text/html,<html><body><h1>Logging</h1></body></html>")
    driver.execute_script("""
        window.webmcp = window.webmcp || {};
        window.webmcp.registerTool({ name: 'logged_blocked_tool', description: 'desc' });
    """)
    
    time.sleep(1) # wait for message to pass from main world -> isolated world -> service worker
    
    logs = driver.execute_script("""
        let cb = arguments[arguments.length - 1];
        chrome.storage.local.get(['webmcp_interception_logs'], (res) => cb(res.webmcp_interception_logs));
    """)
    
    assert logs is not None
    assert len(logs) >= 1
    assert logs[0]['actionTaken'] == 'blocked'
    assert logs[0]['originalToolName'] == 'logged_blocked_tool'

def test_rename_param(driver, mock_server):
    set_rules([
        {
            "actionType": "rename_param",
            "targetToolName": "weather_api",
            "targetParam": "city",
            "renameTo": "location"
        }
    ])
    
    driver.get("data:text/html,<html><body><h1>Test Page</h1></body></html>")
    
    driver.execute_script("""
        window.webmcp.registerTool({ 
            name: 'weather_api', 
            description: 'Get weather',
            inputSchema: {
                type: 'object',
                properties: {
                    city: { type: 'string', description: 'City name' },
                    unit: { type: 'string' }
                },
                required: ['city']
            }
        });
    """)
    
    tools = get_tools_from_page(driver)
    weather_tool = next((t for t in tools if t['name'] == 'weather_api'), None)
    
    assert weather_tool is not None
    assert 'city' not in weather_tool['inputSchema']['properties']
    assert 'location' in weather_tool['inputSchema']['properties']
    assert weather_tool['inputSchema']['properties']['location']['description'] == 'City name'
    assert 'location' in weather_tool['inputSchema']['required']
    assert 'city' not in weather_tool['inputSchema']['required']

def test_rewrite_param_desc(driver, mock_server):
    set_rules([
        {
            "actionType": "rewrite_param_desc",
            "targetToolName": "weather_api",
            "targetParam": "city",
            "rewriteConfig": {
                "mode": "append",
                "replacement": " (e.g. London)"
            }
        }
    ])
    
    driver.get("data:text/html,<html><body><h1>Test Page</h1></body></html>")
    
    driver.execute_script("""
        window.webmcp.registerTool({ 
            name: 'weather_api', 
            description: 'Get weather',
            inputSchema: {
                type: 'object',
                properties: {
                    city: { type: 'string', description: 'City name' }
                }
            }
        });
    """)
    
    tools = get_tools_from_page(driver)
    weather_tool = next((t for t in tools if t['name'] == 'weather_api'), None)
    
    assert weather_tool is not None
    assert 'city' in weather_tool['inputSchema']['properties']
    assert weather_tool['inputSchema']['properties']['city']['description'] == 'City name (e.g. London)'

