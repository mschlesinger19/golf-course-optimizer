import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// GitHub Pages serves a project site from /<repo>/, so the asset base has to
// match. Local dev and preview stay at the root.
const base = process.env.GITHUB_ACTIONS ? '/golf-course-optimizer/' : '/';

export default defineConfig({
  base,
  plugins: [react()],
});
