# Listen, Google - AI Feedback Router

Listen, Google is an intelligent feedback routing system designed for Googlers. It uses a multi-agent AI architecture to analyze natural language feedback and route it to the appropriate internal systems (Buganizer, GUTS, Googlegeist, etc.).

## AI Architecture

1.  **Emergency/Compliance Guardrail**: Fast check for critical issues (fire, bribery, discrimination).
2.  **Classification Agent (Gemini)**: Categorizes feedback using the `routing_schema.json`.
3.  **Judging Agent (Gemini)**: Verifies the classification accuracy.
4.  **Deduplication Mock**: Checks for existing reports in the ecosystem.
5.  **Dynamic Triage**: Intelligent routing to team-specific intake paths.

---

## Setup Instructions

### 1. Gemini API Safety Settings
To ensure the **Emergency Guardrail** works correctly without being blocked by default safety filters when testing keywords like "bribery" or "discrimination":
1. Open your project in **Google AI Studio**.
2. Go to the **Safety Settings** for the model you are using.
3. Set all categories to **"Block None"**.

### Environment Variables
- `GEMINI_API_KEY`: Your Gemini API key.
