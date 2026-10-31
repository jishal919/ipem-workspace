//agent\src\config.js
const path = require('path');

const PORT = 9000;
const PROJECTS_PATH = process.env.PROJECTS_PATH || path.resolve(__dirname, '..', '..');

module.exports = {
  PORT,
  PROJECTS_PATH,
  MEM_PATH: path.join(PROJECTS_PATH, 'memory', 'facts.json'),
  DB_PATH: path.join(PROJECTS_PATH, 'memory', 'ipem.sqlite'),
  LAST_PROGRAM_PATH: path.join(PROJECTS_PATH, 'memory', 'last_program.json'),
  GENERATED_DIR: path.join(PROJECTS_PATH, 'generated'),
  LOGS_DIR: path.join(PROJECTS_PATH, 'logs'),
  USE_DOCKER: process.env.USE_DOCKER === 'true', // Default FALSE — enable only when needed
  LITELLM_PORT: parseInt(process.env.LITELLM_PORT || '4000', 10),
  LITELLM_BASE_URL: process.env.LITELLM_BASE_URL || 'http://localhost:4000',
  DOCKER_IMAGES: {
    python: 'python:3.11-slim',
    javascript: 'node:20-slim',
    typescript: 'node:20-slim' // ts-node needs to be installed or use a specialized image
  }
};
