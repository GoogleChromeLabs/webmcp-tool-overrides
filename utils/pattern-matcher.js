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

// Pattern Matcher Utility
// Provides origin & URL glob matching and tool name string/regex matching.

// Convert a glob pattern into a RegExp.
export function globToRegex(pattern) {
  if (!pattern || pattern === '*' || pattern === '*://*/*') {
    return /^.*$/;
  }

  // Escape special regex characters except '*' and '?'
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  // Replace glob wildcards '*' with '.*' and '?' with '.'
  const regexString = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');

  return new RegExp(`^${regexString}$`, 'i');
}

// Check if a given target URL or origin matches a pattern.
export function matchOrigin(targetUrl, pattern) {
  if (!pattern || pattern === '*' || pattern === '*://*/*') return true;
  if (!targetUrl) return false;

  try {
    let urlStr = targetUrl;
    if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
      urlStr = `http://${urlStr}`;
    }

    // Normalize pattern
    let normalizedPattern = pattern;
    if (!normalizedPattern.includes('://')) {
      normalizedPattern = `*://${normalizedPattern}`;
    }
    if (!normalizedPattern.endsWith('/') && !normalizedPattern.endsWith('*')) {
      normalizedPattern = `${normalizedPattern}/*`;
    }

    const regex = globToRegex(normalizedPattern);

    // Test against full URL, URL with trailing slash, and origin root
    const urlObj = new URL(urlStr);
    const originRootStr = `${urlObj.protocol}//${urlObj.host}/`;

    return regex.test(urlStr) || regex.test(`${urlStr}/`) || regex.test(originRootStr);
  } catch {
    // Fallback direct glob test
    return globToRegex(pattern).test(targetUrl);
  }
}

// Check if a tool name matches a rule target.
export function matchToolName(toolName, targetPattern, isRegex = false) {
  if (!toolName || !targetPattern) return false;
  if (targetPattern === '*') return true;

  if (isRegex) {
    try {
      const rx = new RegExp(targetPattern, 'i');
      return rx.test(toolName);
    } catch {
      console.warn('[WebMCP Matcher] Invalid regex pattern:', targetPattern);
      return false;
    }
  }

  // Exact match or wildcard match
  if (targetPattern.includes('*')) {
    return globToRegex(targetPattern).test(toolName);
  }

  return toolName.toLowerCase() === targetPattern.toLowerCase();
}
