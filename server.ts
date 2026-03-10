import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import cookieParser from 'cookie-parser';
import fs from 'fs/promises';
import path from 'path';

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(cookieParser());

// Agent 5: Dynamic Triage (Registry-based)
async function getTriageLink(teamKey: string) {
  try {
    const registryPath = path.join(process.cwd(), 'triage-registry.json');
    const registryData = await fs.readFile(registryPath, 'utf-8');
    const registry = JSON.parse(registryData);

    const teamConfig = registry[teamKey.toLowerCase()];

    if (!teamConfig) {
      return { 
        success: false, 
        error: 'Team Not Found', 
        details: `The team "${teamKey}" is not in our registry.` 
      };
    }

    const { formId, name } = teamConfig;
    const formUrl = `https://docs.google.com/forms/d/e/${formId}/viewform`;

    return { 
      success: true, 
      team: name,
      formUrl: formUrl,
      method: 'direct'
    };
  } catch (error: any) {
    console.error('Error in dynamic triage:', error);
    return { 
      success: false, 
      error: 'Triage Error',
      details: error.message
    };
  }
}

// API Routes
app.post('/api/triage', async (req, res) => {
  const { text, analysis, team } = req.body;

  if (!analysis || !text) {
    return res.status(400).json({ error: 'Feedback text and analysis are required' });
  }

  let targetTeam = team;
  if (!targetTeam && analysis.category === 'Manager/Team/Work Feedback') {
    targetTeam = 'googlegeist';
  }

  if (targetTeam) {
    const triageResult = await getTriageLink(targetTeam);
    return res.json({ success: true, triage: triageResult });
  }

  res.json({ success: true, triage: { success: true, mocked: true, details: 'No specific triage form required for this category.' } });
});

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Serve static files from dist in production
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    
    // SPA fallback: serve index.html for all non-API routes
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
