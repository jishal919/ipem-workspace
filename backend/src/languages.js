//agent\src\languages.js
const { exec, execSync } = require('child_process');
const path = require('path');

const LANGUAGES = {
  python: {
    check: 'python --version',
    run: (file) => `python "${file}"`,
    spawn: 'python',
    extensions: ['.py'],
    install: 'winget install Python.Python.3',
    codeMarkers: ['def ', 'import ', 'print(', 'class ', 'elif ', 'pip install']
  },
  javascript: {
    check: 'node --version',
    run: (file) => `node "${file}"`,
    spawn: 'node',
    extensions: ['.js'],
    install: 'winget install OpenJS.NodeJS',
    codeMarkers: ['const ', 'let ', 'var ', 'require(', 'console.log', '=>', 'module.exports']
  },
  typescript: {
    check: 'ts-node --version',
    run: (file) => `ts-node "${file}"`,
    spawn: 'ts-node',
    extensions: ['.ts'],
    install: 'npm install -g ts-node typescript',
    codeMarkers: ['interface ', ': string', ': number', ': boolean', 'type ', 'as string']
  },
  java: {
    check: 'java --version',
    run: (file) => `java "${file}"`,
    spawn: 'java',
    extensions: ['.java'],
    install: 'winget install Microsoft.OpenJDK.21',
    codeMarkers: ['public class ', 'public static void main', 'System.out.println', 'import java.']
  },
  go: {
    check: 'go version',
    run: (file) => `go run "${file}"`,
    spawn: 'go',
    extensions: ['.go'],
    install: 'winget install GoLang.Go',
    codeMarkers: ['package main', 'func main()', 'fmt.Println', 'import (']
  },
  rust: {
    check: 'rustc --version',
    run: (file) => `rustc "${file}" -o output && output`,
    spawn: 'rustc',
    extensions: ['.rs'],
    install: 'winget install Rustlang.Rustup',
    codeMarkers: ['fn main()', 'println!', 'let mut ', 'use std::']
  },
  cpp: {
    check: 'g++ --version',
    run: (file) => {
      const out = file.replace(/\.cpp$/, '.exe');
      return `g++ "${file}" -o "${out}" && "${out}"`;
    },
    spawn: 'g++',
    extensions: ['.cpp'],
    install: 'winget install GnuWin32.Make',
    codeMarkers: ['#include', 'int main()', 'std::cout', 'cout <<']
  },
  c: {
    check: 'gcc --version',
    run: (file) => {
      const out = file.replace(/\.c$/, '.exe');
      return `gcc "${file}" -o "${out}" && "${out}"`;
    },
    spawn: 'gcc',
    extensions: ['.c'],
    install: 'winget install GnuWin32.Make',
    codeMarkers: ['#include <stdio.h>', 'printf(', 'scanf(']
  },
  ruby: {
    check: 'ruby --version',
    run: (file) => `ruby "${file}"`,
    spawn: 'ruby',
    extensions: ['.rb'],
    install: 'winget install RubyInstallerTeam.Ruby',
    codeMarkers: ['puts ', 'def ', 'end', 'require ', '.each do']
  },
  php: {
    check: 'php --version',
    run: (file) => `php "${file}"`,
    spawn: 'php',
    extensions: ['.php'],
    install: 'winget install PHP.PHP',
    codeMarkers: ['<?php', 'echo ', '$', '->', 'function ']
  }
};

const FENCE_MAP = {
  python: 'python', py: 'python',
  javascript: 'javascript', js: 'javascript',
  typescript: 'typescript', ts: 'typescript',
  java: 'java',
  go: 'go', golang: 'go',
  rust: 'rust', rs: 'rust',
  cpp: 'cpp', 'c++': 'cpp',
  c: 'c',
  ruby: 'ruby', rb: 'ruby',
  php: 'php'
};

function detectLanguageFromFilename(filename) {
  const ext = path.extname(filename).toLowerCase();
  for (const [lang, config] of Object.entries(LANGUAGES)) {
    if (config.extensions.includes(ext)) return lang;
  }
  return null;
}

function detectLanguageFromCode(code) {
  const fenceMatch = code.match(/^```(\w+)/m);
  if (fenceMatch) {
    const fenceLang = fenceMatch[1].toLowerCase();
    if (FENCE_MAP[fenceLang]) return FENCE_MAP[fenceLang];
  }
  const scores = {};
  for (const [lang, config] of Object.entries(LANGUAGES)) {
    scores[lang] = 0;
    for (const marker of config.codeMarkers) {
      if (code.includes(marker)) scores[lang]++;
    }
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] > 0) return best[0];
  return 'python';
}

function getExtension(lang) {
  return LANGUAGES[lang]?.extensions[0] || '.py';
}

function stripCodeFences(code) {
  if (typeof code !== 'string') return '';

  let c = code.trim();

  // Unwrap JSON string literal: "line1\nline2" → actual multiline
  if (c.startsWith('"') && c.endsWith('"')) {
    try {
      const parsed = JSON.parse(c);
      if (typeof parsed === 'string') c = parsed;
    } catch {}
  }

  // Strip markdown fences: ```python ... ```
  c = c.replace(/^```[\w]*\r?\n?/m, '').replace(/```\s*$/m, '').trim();

  return c;
}

function isInstalled(lang) {
  if (!LANGUAGES[lang]) return false;
  try {
    execSync(LANGUAGES[lang].check, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function installLanguage(lang) {
  return new Promise((resolve, reject) => {
    if (!LANGUAGES[lang]) return reject(new Error(`Unsupported language: ${lang}`));
    exec(LANGUAGES[lang].install, (error, stdout, stderr) => {
      if (error) reject({ error: error.message, stderr });
      else resolve({ stdout, message: `${lang} installed successfully` });
    });
  });
}

function getLanguageStatus() {
  const status = {};
  for (const lang of Object.keys(LANGUAGES)) {
    status[lang] = isInstalled(lang);
  }
  return status;
}

module.exports = {
  LANGUAGES,
  FENCE_MAP,
  detectLanguageFromFilename,
  detectLanguageFromCode,
  getExtension,
  stripCodeFences,
  isInstalled,
  installLanguage,
  getLanguageStatus
};
