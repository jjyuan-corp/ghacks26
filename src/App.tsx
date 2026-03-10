import React, { useState, useCallback, useEffect } from 'react';
import { GoogleGenAI, Type } from "@google/genai";
import { motion, AnimatePresence } from "motion/react";
import { 
  MessageSquare, 
  Loader2, 
  AlertCircle, 
  CheckCircle2, 
  History,
  Info,
  ExternalLink,
  ChevronRight,
  Sparkles,
  PlusCircle,
  Bug,
  Ticket as TicketIcon
} from 'lucide-react';

// --- GUTS Types ---
interface GutsTicketData {
  summary: string;
  description: string;
  component: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
}

type GutsAppState = 'idle' | 'parsing' | 'review' | 'filing' | 'success';

// --- Buganizer Types ---
interface BuganizerTicketData {
  title: string;
  description: string;
  component: string;
  assignee?: string;
  cc?: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
}

type BuganizerAppState = 'idle' | 'parsing' | 'review' | 'filing' | 'success';

interface FeedbackAnalysis {
  category: string;
  justification: string;
  likely_destination: string;
  summary: string;
  is_sufficient: boolean;
  follow_up_questions?: string[];
  critical?: boolean;
  duplicate?: boolean;
  existingFeature?: {
    exists: boolean;
    howTo: string;
    sourceUrl?: string;
  };
  threadLink?: string;
  message?: string;
  team?: string; // Identified team for triage
  fullText?: string; // The full text (original + follow-ups) that was analyzed
  triage?: {
    success: boolean;
    mocked: boolean;
    error?: string;
    details?: string;
    team?: string;
    formUrl?: string;
  };
}

interface FeedbackStatus {
  id: string;
  summary: string;
  status: string;
  date: string;
}

const SYSTEM_INSTRUCTION = `You are an intelligent assistant for Googlers, designed to understand and categorize their feedback to where they should be rerouted. Please analyze the feedback text provided. Determine the most appropriate category and the likely destination system for this feedback.

The main categories are:
- Bug Report: Issues with software, tools, or applications. Likely destination: Buganizer.
- Feature Request: Suggestions for new features or improvements to existing tools. Likely destination: Buganizer or product-specific ideas list.
- Office/Facilities Issue: Problems with the physical office space, amenities, or building. Likely destination: GUTS.
- Food Feedback: Comments or suggestions about cafes, food, or micro kitchens. Likely destination: Go/Foodback.
- Dogfood Feedback: Feedback on internal pre-release products or features. Likely destination: The specific dogfood's feedback form or Buganizer component.
- Manager/Team/Work Feedback: Comments about team dynamics, leadership, culture, or work processes. This includes all HR and people-related feedback. Likely destination: Go/googlegeist-always-on.
- Other: Anything that doesn't fit above. Feel free to categorize them yourself and suggest likely destination.

You MUST also determine if the feedback is SUFFICIENT for the responsible team to intervene. 
- ANCHORING POINT: Only ask follow-up questions if they are ABSOLUTELY NECESSARY for a technician or developer to take action. If the feedback is clear enough to start an investigation, set 'is_sufficient' to true.
- If it's a bug, does it point to specific software?
- If it's a broken printer/machine, does it mention the specific item name or floor? (Do NOT ask for building or office location as that is pulled from backend).
- If it's food feedback, does it mention the specific cafe or micro-kitchen?
- If it's dogfood feedback, does it mention the specific product or feature name?
- If it's leadership or HR feedback, it MUST go to Go/googlegeist-always-on.
- Do NOT ask for "impact on team", "team name", or "how it makes you feel" as that is unnecessary.
- ONLY ask for missing technical/locational details that are the difference between "we can fix this" and "we don't know where to look".
- For "Manager/Team/Work Feedback" (Googlegeist), ALWAYS set 'is_sufficient' to true and do NOT provide follow-up questions. This category never requires follow-up.

Output your analysis in JSON format with the following fields:
- 'category': The most fitting category from the list above.
- 'justification': A brief, clean explanation of why this category was chosen. DO NOT include internal notes like "Judgment correction" or "Dynamic Discovery" in this field.
- 'likely_destination': The system/place this feedback should ideally go.
- 'summary': A concise summary of the feedback.
- 'is_sufficient': boolean, true if there is enough detail for action, false otherwise.
- 'follow_up_questions': array of strings, questions to ask the user if 'is_sufficient' is false. Limit to 1 highly specific question.`;

const FEEDBACK_EXAMPLES = [
  "The internal dashboard is throwing a 500 error when I try to export the Q1 report.",
  "I wish we had climbing classes on campus in NYC.",
  "The coffee machine on the 4th floor of NYC-9th is leaking.",
  "The micro-kitchen in building 43 is out of sparkling water.",
  "The vegan options at the Big Table cafe have been a bit repetitive lately.",
  "I'm seeing a weird UI glitch in the latest Gemini Dogfood build on Android.",
  "I feel like our team meetings could be more efficient if we had a clear agenda beforehand.",
  "The shuttle from Mountain View to San Francisco was 15 minutes late this morning.",
  "Can we add a dark mode to the internal Moma search results page?",
  "The gym equipment in the Charleston East fitness center needs maintenance."
];

export default function App() {
  const [feedback, setFeedback] = useState('Listen, Google, ');
  const [placeholder, setPlaceholder] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [followUpResponse, setFollowUpResponse] = useState('');
  const [analysis, setAnalysis] = useState<FeedbackAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<FeedbackStatus[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [triageThinking, setTriageThinking] = useState<string | null>(null);

  useEffect(() => {
    const randomExample = FEEDBACK_EXAMPLES[Math.floor(Math.random() * FEEDBACK_EXAMPLES.length)];
    setPlaceholder(randomExample);
  }, []);

  // GUTS Simulation State
  const [gutsState, setGutsState] = useState<GutsAppState>('idle');
  const [gutsTicket, setGutsTicket] = useState<GutsTicketData | null>(null);
  const [filedGutsId, setFiledGutsId] = useState<string | null>(null);

  // Buganizer Simulation State
  const [buganizerState, setBuganizerState] = useState<BuganizerAppState>('idle');
  const [buganizerTicket, setBuganizerTicket] = useState<BuganizerTicketData | null>(null);
  const [filedBugId, setFiledBugId] = useState<string | null>(null);

  // Agent 1: Emergency/Compliance Guardrail
  const emergencyGuardrail = (text: string) => {
    const criticalKeywords = ['fire', 'bribery', 'discrimination', 'ethics', 'harassment', 'safety', 'emergency'];
    const lowerText = text.toLowerCase();
    if (criticalKeywords.some(keyword => lowerText.includes(keyword))) {
      return {
        flagged: true,
        destination: 'go/ethics or go/notify',
        message: 'Critical issue detected. Please route to go/ethics or go/notify immediately.'
      };
    }
    return { flagged: false };
  };

  // Agent: Reality Check (Feature Existence)
  const checkExistingFeature = async (text: string, category: string) => {
    if (category !== 'Feature Request' && category !== 'Other') return null;
    
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return null;
      const ai = new GoogleGenAI({ apiKey });
      
      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: `The user is providing feedback/request: "${text}". 
        Check if this feature or service already exists at Google for employees or as a public product.
        
        If it exists, explain briefly how to access it or use it.
        If it doesn't exist or you are unsure, say it doesn't exist.
        
        Return a JSON object with:
        'exists': boolean
        'howTo': string (brief instructions or explanation)
        'sourceUrl': string (optional link to documentation or the tool)`,
        config: { 
          responseMimeType: 'application/json',
          tools: [{ googleSearch: {} }]
        }
      });
      
      const data = JSON.parse(response.text || '{}');
      return data.exists ? data : null;
    } catch (e) {
      console.error("Reality check error:", e);
      return null;
    }
  };

  // Agent 4: Deduplication Mock
  const deduplicate = (text: string, category: string) => {
    if (category === 'Manager/Team/Work Feedback') return null;
    
    // For demo purposes: 50% chance of triggering a duplicate warning for non-manager feedback
    if (Math.random() < 0.5) {
      return {
        isDuplicate: true,
        threadLink: 'https://buganizer.corp.google.com/issues/12345678',
        message: 'A similar issue has been reported. Would you like to view the existing thread?'
      };
    }
    return null;
  };

  // Agent: GUTS Parser
  const parseGutsTicket = async (input: string): Promise<GutsTicketData> => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("API Key missing");
    const ai = new GoogleGenAI({ apiKey });
    
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Parse the following natural language request into a GUTS ticket. 
      If the user doesn't specify a priority, default to P2.
      If the user doesn't specify a component, try to infer it from the context or use "General Support".
      
      Request: "${input}"`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING, description: "A concise summary of the issue." },
            description: { type: Type.STRING, description: "A detailed description of the issue." },
            component: { type: Type.STRING, description: "The GUTS component or queue name." },
            priority: { 
              type: Type.STRING, 
              enum: ["P0", "P1", "P2", "P3", "P4"],
              description: "The priority of the ticket."
            },
          },
          required: ["summary", "description", "component", "priority"],
        },
      },
    });

    return JSON.parse(response.text || '{}') as GutsTicketData;
  };

  const handleAnalyze = useCallback(async (force = false, additionalText = '') => {
    const fullText = additionalText ? `${feedback}\n\nAdditional Details: ${additionalText}` : feedback;
    if (!fullText.trim() || fullText.trim() === 'Listen, Google,') return;

    if (additionalText) {
      setFeedback(fullText);
    }

    setIsAnalyzing(true);
    setIsSubmitting(false);
    setError(null);
    setAnalysis(null);
    setSubmitted(false);
    setFollowUpResponse('');
    setTriageThinking(null);
    setGutsState('idle');
    setGutsTicket(null);
    setFiledGutsId(null);

    // Agent 1: Guardrail
    const guardrail = emergencyGuardrail(fullText);
    if (guardrail.flagged) {
      const data: FeedbackAnalysis = {
        category: 'Critical/Compliance',
        justification: guardrail.message,
        likely_destination: guardrail.destination,
        summary: 'Emergency/Compliance issue detected.',
        is_sufficient: true,
        critical: true
      };
      setAnalysis(data);
      setIsAnalyzing(false);
      return;
    }

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY is missing. Please add it to your secrets.");

      const ai = new GoogleGenAI({ apiKey });
      
      // Agent 2: Classification
      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: `Analyze the following feedback: ${fullText}`,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
        },
      });

      if (!response.text) throw new Error("No analysis generated by the AI.");
      
      let data = JSON.parse(response.text) as FeedbackAnalysis;
      data.fullText = fullText; // Store the context used for this analysis

      // Agent 2.5: Team Identification & Duplicate Search (Moma Search Simulation)
      if (data.category !== 'Manager/Team/Work Feedback') {
        setTriageThinking("Searching Moma for duplicate reports and responsible teams...");
        const teamResponse = await ai.models.generateContent({
          model: "gemini-3.1-pro-preview",
          contents: `Based on this feedback: "${fullText}", which specific Google team, project, or dogfood is most likely responsible for addressing this? 
          
          Also, check if similar issues have been reported recently.
          
          If the feedback mentions a specific team (e.g. gHacks, Googlegeist, REWS) or a specific dogfood (e.g. "Gemini Dogfood", "Workspace Dogfood"), identify them.
          Search for the team's feedback form, Buganizer component, or dogfood intake path if possible.
          
          Return a JSON object with:
          'team': string (lowercase key, e.g. 'ghacks' or 'gemini_dogfood')
          'teamName': string (display name, e.g. 'gHacks Team' or 'Gemini Dogfood Program')
          'destination': string (e.g. 'gHacks Feedback Form' or 'go/gemini-dogfood-feedback')
          'reasoning': string`,
          config: { 
            responseMimeType: 'application/json',
            tools: [{ googleSearch: {} }]
          }
        });
        const teamData = JSON.parse(teamResponse.text || '{}');
        if (teamData.team) {
          data.team = teamData.team;
          data.likely_destination = teamData.destination || (teamData.teamName + " Feedback Form");
        }
        setTriageThinking(null);
      }

      // Agent 3: Judging (Verification)
      const judgingResponse = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Evaluate the following classification for accuracy based on the routing guidelines.
Feedback: "${fullText}"
Classification: ${JSON.stringify(data)}

If the category is incorrect, provide the correct one.
Return a JSON object with:
'approved': boolean
'correction': string (explanation of the correction)
'newCategory': string (the corrected category name if not approved)
'newDestination': string (the corrected destination if not approved)
'newJustification': string (a clean, final justification if not approved)`,
        config: { responseMimeType: 'application/json' }
      });

      const judgment = JSON.parse(judgingResponse.text || '{"approved": true}');
      if (!judgment.approved) {
        if (judgment.newCategory) data.category = judgment.newCategory;
        if (judgment.newDestination) data.likely_destination = judgment.newDestination;
        if (judgment.newJustification) data.justification = judgment.newJustification;
      }

      // Agent 3.5: Reality Check (Existing Feature)
      if (data.category === 'Feature Request' || data.category === 'Other') {
        setTriageThinking("Checking if this feature already exists...");
        const existing = await checkExistingFeature(fullText, data.category);
        if (existing && existing.exists) {
          data.existingFeature = {
            exists: true,
            howTo: existing.howTo,
            sourceUrl: existing.sourceUrl
          };
        }
        setTriageThinking(null);
      }

      // Agent 4: Deduplication (only if not forced)
      if (!force) {
        const dupeResult = deduplicate(fullText, data.category);
        if (dupeResult) {
          setAnalysis({
            ...data,
            duplicate: true,
            threadLink: dupeResult.threadLink,
            message: dupeResult.message
          });
          setIsAnalyzing(false);
          return;
        }
      }

      setAnalysis(data);
      if (additionalText) {
        setFollowUpResponse('');
      }
    } catch (err: any) {
      console.error("Analysis error:", err);
      setError(err.message || "Failed to analyze feedback. Please try again.");
    } finally {
      setIsAnalyzing(false);
    }
  }, [feedback]);

  const handleSubmitAnyway = async () => {
    if (!analysis) return;
    setIsSubmitting(true);
    setError(null);
    
    try {
      // Check if it's a GUTS or Buganizer destination
      const isGuts = analysis.likely_destination.toLowerCase().includes('guts');
      const isBuganizer = analysis.likely_destination.toLowerCase().includes('buganizer');
      const finalFeedback = analysis.fullText || feedback;
      
      if (isGuts) {
        setIsSubmitting(false);
        setGutsState('parsing');
        const gutsData = await parseGutsTicket(finalFeedback);
        setGutsTicket(gutsData);
        setGutsState('review');
        return;
      }

      if (isBuganizer) {
        setIsSubmitting(false);
        setBuganizerState('parsing');
        const bugData = await parseBuganizerTicket(finalFeedback);
        setBuganizerTicket(bugData);
        setBuganizerState('review');
        return;
      }

      let triageData = null;
      // Agent 5: Triage (Dynamic Routing)
      if (analysis.category === 'Manager/Team/Work Feedback' || analysis.team) {
        const triageRes = await fetch('/api/triage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            text: finalFeedback, 
            analysis: analysis,
            team: analysis.team 
          })
        });
        triageData = await triageRes.json();
        
        if (triageData.triage && !triageData.triage.success) {
          setAnalysis({ ...analysis, triage: triageData.triage });
        }
      }

      // Add to session history
      const newEntry: FeedbackStatus = {
        id: Math.random().toString(36).substr(2, 9),
        summary: analysis.summary,
        status: 'Submitted - In Review',
        date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      };
      setHistory(prev => [newEntry, ...prev]);
      setAnalysis(prev => prev ? { ...prev, triage: triageData?.triage } : null);
      setSubmitted(true);
    } catch (err) {
      console.error("Submission error:", err);
      setError("Failed to submit feedback.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFileGuts = async () => {
    setGutsState('filing');
    // Simulate API call to GUTS
    await new Promise(resolve => setTimeout(resolve, 2000));
    const newId = `GUTS-${Math.floor(100000000 + Math.random() * 900000000)}`;
    setFiledGutsId(newId);
    
    // Add to session history
    const newEntry: FeedbackStatus = {
      id: newId,
      summary: gutsTicket?.summary || analysis?.summary || 'GUTS Ticket',
      status: 'Filed in GUTS',
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    };
    setHistory(prev => [newEntry, ...prev]);
    if (analysis) {
      setAnalysis({
        ...analysis,
        triage: {
          success: true,
          mocked: false,
          team: gutsTicket?.component || 'GUTS',
          details: `Ticket ${newId} has been filed successfully in GUTS.`
        }
      });
    }
    setGutsState('success');
  };

  const parseBuganizerTicket = async (text: string): Promise<BuganizerTicketData> => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return {
        title: text.substring(0, 50) + '...',
        description: text,
        component: 'Unknown',
        priority: 'P2'
      };
    }

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Extract Buganizer ticket details from this feedback: "${text}"
      
      Return JSON:
      {
        "title": "Concise bug title",
        "description": "Detailed bug description",
        "component": "Likely Buganizer component path (e.g. Chrome > WebUI)",
        "assignee": "Optional LDAP if mentioned",
        "cc": "Optional CCs",
        "priority": "P0|P1|P2|P3|P4"
      }`,
      config: { responseMimeType: 'application/json' }
    });

    return JSON.parse(response.text || '{}');
  };

  const handleFileBuganizer = async () => {
    setBuganizerState('filing');
    // Simulate API call to Buganizer
    await new Promise(resolve => setTimeout(resolve, 2000));
    const newId = Math.floor(100000000 + Math.random() * 900000000).toString();
    setFiledBugId(newId);
    
    // Add to session history
    const newEntry: FeedbackStatus = {
      id: newId,
      summary: buganizerTicket?.title || analysis?.summary || 'Buganizer Issue',
      status: 'Filed in Buganizer',
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    };
    setHistory(prev => [newEntry, ...prev]);
    if (analysis) {
      setAnalysis({
        ...analysis,
        triage: {
          success: true,
          mocked: false,
          team: buganizerTicket?.component || 'Buganizer',
          details: `Issue ${newId} has been filed successfully in Buganizer.`
        }
      });
    }
    setBuganizerState('success');
  };

  const handleReset = () => {
    setFeedback('Listen, Google, ');
    setAnalysis(null);
    setSubmitted(false);
    setIsAnalyzing(false);
    setIsSubmitting(false);
    setError(null);
    setFollowUpResponse('');
    setTriageThinking(null);
    setGutsState('idle');
    setGutsTicket(null);
    setFiledGutsId(null);
    setBuganizerState('idle');
    setBuganizerTicket(null);
    setFiledBugId(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === 'Enter') {
      handleAnalyze();
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-10 h-10 rounded-full bg-slate-50 flex items-center justify-center">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <defs>
                  <linearGradient id="google-ear-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#4285F4" />
                    <stop offset="33%" stopColor="#EA4335" />
                    <stop offset="66%" stopColor="#FBBC05" />
                    <stop offset="100%" stopColor="#34A853" />
                  </linearGradient>
                </defs>
                <path d="M6 10a6 6 0 1 1 12 0v.5a2.5 2.5 0 0 1-5 0v-1.5a1.5 1.5 0 1 0-3 0v.5" stroke="url(#google-ear-gradient)" />
                <path d="M10 16a2 2 0 1 0 4 0" stroke="url(#google-ear-gradient)" />
              </svg>
            </div>
          </div>
          <h1 className="text-xl font-medium tracking-tight text-slate-800">go/listen-google</h1>
        </div>
        <button 
          onClick={() => setShowHistory(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-full hover:bg-slate-100 transition-colors text-sm font-medium text-slate-600"
        >
          <History className="w-4 h-4" />
          Past Feedback
        </button>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-12">
        {/* Input Section */}
        <section className="space-y-6">
          <div className="relative">
            <div className={`w-full min-h-[120px] p-8 rounded-[2rem] bg-[#E8F0FE] border-none transition-all flex flex-col justify-center ${isFocused ? 'ring-2 ring-blue-500' : ''}`}>
              <div className="relative w-full">
                {/* The actual editable area */}
                <textarea
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  onFocus={() => {
                    setIsFocused(true);
                  }}
                  onBlur={() => setIsFocused(false)}
                  onKeyDown={handleKeyDown}
                  className="w-full bg-transparent border-none outline-none resize-none text-xl leading-relaxed text-transparent relative z-10 caret-slate-900 p-0 m-0 font-normal"
                  rows={2}
                />
                
                {/* Overlay for bolding and placeholder */}
                <div className="absolute inset-0 pointer-events-none text-xl leading-relaxed whitespace-pre-wrap break-words p-0 m-0 font-normal">
                  <div className="p-0">
                    {feedback.startsWith('Listen, Google,') ? (
                      <>
                        <span className="text-slate-900">Listen, Google,</span>
                        <span className="text-slate-900">{feedback.slice(15)}</span>
                      </>
                    ) : (
                      <span className="text-slate-900">{feedback}</span>
                    )}
                    
                    {feedback === 'Listen, Google, ' && !isFocused && (
                      <span className="text-slate-400">{placeholder}</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <button
            onClick={() => handleAnalyze()}
            disabled={isAnalyzing || feedback.trim() === 'Listen, Google,'}
            className="w-full bg-[#1a73e8] hover:bg-blue-700 disabled:bg-slate-300 text-white font-medium py-4 rounded-full shadow-md transition-all flex items-center justify-center gap-2 group"
          >
            {isAnalyzing ? (
              <div className="flex items-center gap-3">
                <Loader2 className="w-5 h-5 animate-spin" />
                {triageThinking && (
                  <span className="text-sm font-medium animate-pulse">
                    {triageThinking}
                  </span>
                )}
              </div>
            ) : (
              <>
                <Sparkles className="w-5 h-5" />
                Send Feedback for Analysis
              </>
            )}
          </button>
        </section>

        {/* Error Message */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-4 p-4 bg-red-50 border border-red-100 rounded-xl flex items-center gap-3 text-red-600 text-sm"
            >
              <AlertCircle className="w-5 h-5 flex-shrink-0" />
              <p>{error}</p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Results Section */}
        <AnimatePresence mode="wait">
          {analysis && (
            <motion.section
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="mt-12 space-y-8"
            >
              <h2 className="text-2xl font-bold text-slate-800">Feedback Analysis</h2>

              <div className={`p-10 rounded-[2rem] border ${analysis.critical ? 'bg-red-50 border-red-100' : 'bg-white border-slate-100 shadow-xl shadow-slate-200/30'}`}>
                {submitted && (
                  <div className="flex items-center gap-3 text-slate-800 mb-8">
                    <CheckCircle2 className="w-6 h-6 text-[#34A853]" />
                    <span className="text-lg font-medium">Feedback submitted successfully.</span>
                  </div>
                )}

                {analysis.critical && (
                  <div className="flex items-center gap-3 text-red-600 mb-8 bg-red-100/50 p-4 rounded-xl">
                    <AlertCircle className="w-6 h-6" />
                    <span className="font-bold tracking-tight">Compliance alert</span>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                  <div className="space-y-3">
                    <p className="text-sm font-bold text-slate-400 tracking-wider">Category</p>
                    <div className="inline-flex px-6 py-2 bg-[#1a73e8] text-white rounded-full text-sm font-medium">
                      {analysis.category}
                    </div>
                  </div>
                  <div className="space-y-3">
                    <p className="text-sm font-bold text-slate-400 tracking-wider">Likely destination</p>
                    <div className="inline-flex items-center gap-2 px-6 py-2 bg-[#E8F0FE] text-[#1a73e8] rounded-lg text-sm font-medium">
                      {analysis.likely_destination}
                      <ExternalLink className="w-4 h-4" />
                    </div>
                  </div>
                </div>

                {/* Existing Feature Reality Check */}
                {analysis.existingFeature && analysis.existingFeature.exists && (
                  <div className="mt-8 p-6 bg-emerald-50 rounded-2xl border border-emerald-100 space-y-4">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0">
                        <Sparkles className="w-5 h-5 text-emerald-600" />
                      </div>
                      <div className="space-y-2">
                        <h4 className="text-emerald-900 font-bold flex items-center gap-2">
                          Good news! This feature already exists.
                        </h4>
                        <p className="text-emerald-800 text-sm leading-relaxed">
                          {analysis.existingFeature.howTo}
                        </p>
                        {analysis.existingFeature.sourceUrl && (
                          <a 
                            href={analysis.existingFeature.sourceUrl} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-emerald-700 hover:underline text-sm font-bold"
                          >
                            Learn more <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <div className="mt-6 pt-6 border-t border-slate-50 space-y-6">
                  <div className="space-y-3 p-6 bg-slate-50/50 rounded-2xl border border-slate-100/50">
                    <p className="text-sm font-bold text-slate-400 tracking-wider">Summary</p>
                    <div className="flex items-start gap-4">
                      <div className="w-1 self-stretch bg-[#1a73e8] rounded-full" />
                      <p className="text-xl text-slate-800 font-medium">{analysis.summary}</p>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <p className="text-sm font-bold text-slate-400 tracking-wider">Justification</p>
                    <p className="text-slate-600 leading-relaxed">{analysis.justification}</p>
                  </div>

                  {analysis.existingFeature?.exists && (
                    <button
                      onClick={handleReset}
                      className="w-full mt-4 py-4 bg-slate-800 text-white rounded-2xl font-bold text-sm hover:bg-slate-900 transition-all shadow-lg active:scale-95 flex items-center justify-center gap-2"
                    >
                      <PlusCircle className="w-4 h-4" />
                      Send a new feedback
                    </button>
                  )}
                </div>

                {/* Follow-up Questions */}
                {!analysis.is_sufficient && analysis.follow_up_questions && analysis.follow_up_questions.length > 0 && (
                  <div className="mt-8 p-6 bg-blue-50 rounded-2xl border border-blue-100 space-y-4">
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-blue-700 font-bold text-sm tracking-wider">
                        <MessageSquare className="w-4 h-4" />
                        More information needed
                      </div>
                      <p className="text-sm text-blue-800">To help the team intervene effectively, could you clarify:</p>
                      <ul className="list-disc list-inside space-y-1 text-sm text-blue-700">
                        {analysis.follow_up_questions.map((q, i) => (
                          <li key={i}>{q}</li>
                        ))}
                      </ul>
                    </div>
                    
                    <div className="space-y-3 pt-2">
                      <textarea
                        value={followUpResponse}
                        onChange={(e) => setFollowUpResponse(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                            e.preventDefault();
                            handleAnalyze(false, followUpResponse);
                          }
                        }}
                        placeholder="Provide the missing details here... (Ctrl+Enter to update)"
                        className="w-full p-4 rounded-xl border border-blue-200 focus:ring-2 focus:ring-blue-500 outline-none text-sm transition-all"
                      />
                      <button
                        onClick={() => handleAnalyze(false, followUpResponse)}
                        disabled={isAnalyzing || !followUpResponse.trim()}
                        className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
                      >
                        {isAnalyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Update Analysis"}
                      </button>
                    </div>
                  </div>
                )}

                {analysis.duplicate && (
                  <div className="mt-8 p-6 bg-amber-50 rounded-2xl border border-amber-100 space-y-4">
                    <div className="flex items-start gap-3">
                      <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5" />
                      <div className="space-y-2">
                        <p className="text-amber-900 font-medium">{analysis.message}</p>
                        <a 
                          href={analysis.threadLink} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-amber-700 hover:underline text-sm font-bold"
                        >
                          View Existing Thread <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    </div>
                  </div>
                )}

                {/* Submit Anyway Section */}
                {!submitted && gutsState === 'idle' && buganizerState === 'idle' && !analysis.existingFeature?.exists ? (
                  <div className="mt-8 pt-8 border-t border-slate-50">
                    <button
                      onClick={handleSubmitAnyway}
                      disabled={isSubmitting}
                      className="w-full bg-[#1a73e8] hover:bg-blue-700 text-white font-bold py-4 rounded-2xl shadow-lg shadow-blue-100 transition-all flex items-center justify-center gap-2 group active:scale-[0.98]"
                    >
                      {isSubmitting ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        <>
                          <Sparkles className="w-5 h-5 group-hover:rotate-12 transition-transform" />
                          {analysis.duplicate 
                            ? `Generate ${analysis.likely_destination} ticket anyway` 
                            : `Generate ${analysis.likely_destination} ticket`}
                        </>
                      )}
                    </button>
                  </div>
                ) : !submitted && (gutsState !== 'idle' || buganizerState !== 'idle') ? (
                  <div className="mt-8 pt-8 border-t border-slate-100 space-y-8">
                    <AnimatePresence mode="wait">
                      {gutsState === 'parsing' && (
                        <motion.div
                          key="guts-parsing"
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          className="flex flex-col items-center py-12 space-y-4"
                        >
                          <div className="relative">
                            <Loader2 className="w-12 h-12 animate-spin text-blue-600" />
                            <Sparkles className="w-5 h-5 text-blue-400 absolute inset-0 m-auto" />
                          </div>
                          <div className="text-center">
                            <p className="text-xl font-medium text-slate-800">Drafting your ticket...</p>
                            <p className="text-sm text-slate-500 mt-1">Gemini is structuring your feedback for {analysis.likely_destination}</p>
                          </div>
                        </motion.div>
                      )}

                      {gutsState === 'review' && gutsTicket && (
                        <motion.div
                          key="guts-review"
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="space-y-8"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <TicketIcon className="w-6 h-6 text-blue-600" />
                              <h3 className="text-xl font-bold text-slate-800 tracking-tight">Draft a ticket</h3>
                            </div>
                            <button 
                              onClick={() => setGutsState('idle')}
                              className="text-sm font-medium text-slate-400 hover:text-slate-600 transition-colors"
                            >
                              Cancel
                            </button>
                          </div>

                          <div className="space-y-6">
                            {/* Priority Chips */}
                            <div className="space-y-3">
                              <label className="text-sm font-medium text-slate-700 ml-1">Priority</label>
                              <div className="flex flex-wrap gap-2">
                                {(['P0', 'P1', 'P2', 'P3', 'P4'] as const).map((p) => (
                                  <button
                                    key={p}
                                    onClick={() => setGutsTicket({ ...gutsTicket, priority: p })}
                                    className={`px-5 py-2 rounded-full text-sm font-bold transition-all border-2 ${
                                      gutsTicket.priority === p 
                                        ? p === 'P0' ? 'bg-red-50 border-red-500 text-red-700' :
                                          p === 'P1' ? 'bg-orange-50 border-orange-500 text-orange-700' :
                                          'bg-blue-50 border-blue-500 text-blue-700'
                                        : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'
                                    }`}
                                  >
                                    {p}
                                  </button>
                                ))}
                              </div>
                            </div>

                            {/* MD3 Outlined Fields */}
                            <div className="grid grid-cols-1 gap-6">
                              <div className="relative group">
                                <div className="absolute -top-2.5 left-3 px-1 bg-white text-[11px] font-bold text-slate-400 group-focus-within:text-blue-600 transition-colors z-10">
                                  Component
                                </div>
                                <input 
                                  type="text"
                                  value={gutsTicket.component}
                                  onChange={(e) => setGutsTicket({...gutsTicket, component: e.target.value})}
                                  className="w-full px-4 py-4 rounded-xl border-2 border-slate-200 focus:border-blue-500 outline-none text-slate-800 font-medium transition-all bg-white"
                                />
                              </div>

                              <div className="relative group">
                                <div className="absolute -top-2.5 left-3 px-1 bg-white text-[11px] font-bold text-slate-400 group-focus-within:text-blue-600 transition-colors z-10">
                                  Ticket title
                                </div>
                                <input 
                                  type="text"
                                  value={gutsTicket.summary}
                                  onChange={(e) => setGutsTicket({...gutsTicket, summary: e.target.value})}
                                  className="w-full px-4 py-4 rounded-xl border-2 border-slate-200 focus:border-blue-500 outline-none text-slate-800 font-medium transition-all bg-white"
                                />
                              </div>

                              <div className="relative group">
                                <div className="absolute -top-2.5 left-3 px-1 bg-white text-[11px] font-bold text-slate-400 group-focus-within:text-blue-600 transition-colors z-10">
                                  Description
                                </div>
                                <textarea 
                                  value={gutsTicket.description}
                                  rows={4}
                                  onChange={(e) => setGutsTicket({...gutsTicket, description: e.target.value})}
                                  className="w-full px-4 py-4 rounded-xl border-2 border-slate-200 focus:border-blue-500 outline-none text-slate-800 text-sm leading-relaxed transition-all bg-white resize-none"
                                />
                              </div>
                            </div>
                          </div>

                          <div className="flex justify-end pt-4">
                            <button
                              onClick={handleFileGuts}
                              className="bg-[#1a73e8] hover:bg-blue-700 text-white font-bold px-8 py-4 rounded-2xl shadow-lg shadow-blue-100 transition-all flex items-center justify-center gap-2 group active:scale-95"
                            >
                              File GUTS Ticket
                              <ExternalLink className="w-5 h-5 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                            </button>
                          </div>
                        </motion.div>
                      )}

                      {gutsState === 'filing' && (
                        <motion.div
                          key="guts-filing"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          className="flex flex-col items-center py-16 space-y-6"
                        >
                          <div className="relative">
                            <Loader2 className="w-16 h-16 animate-spin text-blue-600" />
                            <TicketIcon className="w-6 h-6 text-blue-400 absolute inset-0 m-auto" />
                          </div>
                          <div className="text-center">
                            <p className="text-xl font-bold text-slate-800">Filing Ticket...</p>
                            <p className="text-sm text-slate-500 mt-2">Transmitting data to GUTS secure backend</p>
                          </div>
                        </motion.div>
                      )}

                      {gutsState === 'success' && (
                        <motion.div
                          key="guts-success"
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          className="flex flex-col items-center py-12 space-y-8 text-center"
                        >
                          <div className="w-20 h-20 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center shadow-inner">
                            <CheckCircle2 className="w-10 h-10" />
                          </div>
                          <div className="space-y-3">
                            <h3 className="text-2xl font-bold text-slate-800">Ticket filed successfully</h3>
                            <div className="inline-block px-6 py-3 bg-slate-900 text-white rounded-xl font-mono text-xl font-bold tracking-tight shadow-xl">
                              {filedGutsId}
                            </div>
                          </div>
                          <p className="text-slate-500 max-w-xs leading-relaxed">
                            Your ticket has been queued for review. You will receive notifications as the status changes.
                          </p>
                          <button
                            onClick={handleReset}
                            className="px-12 py-4 bg-slate-800 text-white rounded-2xl font-bold text-sm hover:bg-slate-900 transition-all shadow-lg active:scale-95"
                          >
                            Send a new feedback
                          </button>
                        </motion.div>
                      )}

                      {/* Buganizer Simulation */}
                      {buganizerState === 'parsing' && (
                        <motion.div
                          key="buganizer-parsing"
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          className="flex flex-col items-center py-12 space-y-4"
                        >
                          <div className="relative">
                            <Loader2 className="w-12 h-12 animate-spin text-blue-600" />
                            <Bug className="w-5 h-5 text-blue-400 absolute inset-0 m-auto" />
                          </div>
                          <div className="text-center">
                            <p className="text-xl font-medium text-slate-800">Drafting Buganizer issue...</p>
                            <p className="text-sm text-slate-500 mt-1">Gemini is structuring your feedback for Buganizer</p>
                          </div>
                        </motion.div>
                      )}

                      {buganizerState === 'review' && buganizerTicket && (
                        <motion.div
                          key="buganizer-review"
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="space-y-8"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <Bug className="w-6 h-6 text-blue-600" />
                              <h3 className="text-xl font-bold text-slate-800 tracking-tight">Create Buganizer Issue</h3>
                            </div>
                            <button 
                              onClick={() => setBuganizerState('idle')}
                              className="text-sm font-medium text-slate-400 hover:text-slate-600 transition-colors"
                            >
                              Cancel
                            </button>
                          </div>

                          <div className="space-y-6">
                            {/* Priority Chips */}
                            <div className="space-y-3">
                              <label className="text-sm font-medium text-slate-700 ml-1">Priority</label>
                              <div className="flex flex-wrap gap-2">
                                {(['P0', 'P1', 'P2', 'P3', 'P4'] as const).map((p) => (
                                  <button
                                    key={p}
                                    onClick={() => setBuganizerTicket({ ...buganizerTicket, priority: p })}
                                    className={`px-5 py-2 rounded-full text-sm font-bold transition-all border-2 ${
                                      buganizerTicket.priority === p 
                                        ? p === 'P0' ? 'bg-red-50 border-red-500 text-red-700' :
                                          p === 'P1' ? 'bg-orange-50 border-orange-500 text-orange-700' :
                                          'bg-blue-50 border-blue-500 text-blue-700'
                                        : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'
                                    }`}
                                  >
                                    {p}
                                  </button>
                                ))}
                              </div>
                            </div>

                            {/* MD3 Outlined Fields */}
                            <div className="grid grid-cols-1 gap-6">
                              <div className="relative group">
                                <div className="absolute -top-2.5 left-3 px-1 bg-white text-[11px] font-bold text-slate-400 group-focus-within:text-blue-600 transition-colors z-10">
                                  Component *
                                </div>
                                <input 
                                  type="text"
                                  value={buganizerTicket.component}
                                  onChange={(e) => setBuganizerTicket({...buganizerTicket, component: e.target.value})}
                                  className="w-full px-4 py-4 rounded-xl border-2 border-slate-200 focus:border-blue-500 outline-none text-slate-800 font-medium transition-all bg-white"
                                />
                              </div>

                              <div className="relative group">
                                <div className="absolute -top-2.5 left-3 px-1 bg-white text-[11px] font-bold text-slate-400 group-focus-within:text-blue-600 transition-colors z-10">
                                  Title *
                                </div>
                                <input 
                                  type="text"
                                  value={buganizerTicket.title}
                                  onChange={(e) => setBuganizerTicket({...buganizerTicket, title: e.target.value})}
                                  className="w-full px-4 py-4 rounded-xl border-2 border-slate-200 focus:border-blue-500 outline-none text-slate-800 font-medium transition-all bg-white"
                                />
                              </div>

                              <div className="grid grid-cols-2 gap-4">
                                <div className="relative group">
                                  <div className="absolute -top-2.5 left-3 px-1 bg-white text-[11px] font-bold text-slate-400 group-focus-within:text-blue-600 transition-colors z-10">
                                    Assignee
                                  </div>
                                  <input 
                                    type="text"
                                    value={buganizerTicket.assignee || ''}
                                    placeholder="LDAP"
                                    onChange={(e) => setBuganizerTicket({...buganizerTicket, assignee: e.target.value})}
                                    className="w-full px-4 py-4 rounded-xl border-2 border-slate-200 focus:border-blue-500 outline-none text-slate-800 font-medium transition-all bg-white"
                                  />
                                </div>
                                <div className="relative group">
                                  <div className="absolute -top-2.5 left-3 px-1 bg-white text-[11px] font-bold text-slate-400 group-focus-within:text-blue-600 transition-colors z-10">
                                    CC
                                  </div>
                                  <input 
                                    type="text"
                                    value={buganizerTicket.cc || ''}
                                    placeholder="LDAP, LDAP"
                                    onChange={(e) => setBuganizerTicket({...buganizerTicket, cc: e.target.value})}
                                    className="w-full px-4 py-4 rounded-xl border-2 border-slate-200 focus:border-blue-500 outline-none text-slate-800 font-medium transition-all bg-white"
                                  />
                                </div>
                              </div>

                              <div className="relative group">
                                <div className="absolute -top-2.5 left-3 px-1 bg-white text-[11px] font-bold text-slate-400 group-focus-within:text-blue-600 transition-colors z-10">
                                  Description *
                                </div>
                                <textarea 
                                  value={buganizerTicket.description}
                                  rows={6}
                                  onChange={(e) => setBuganizerTicket({...buganizerTicket, description: e.target.value})}
                                  className="w-full px-4 py-4 rounded-xl border-2 border-slate-200 focus:border-blue-500 outline-none text-slate-800 text-sm leading-relaxed transition-all bg-white resize-none"
                                />
                              </div>
                            </div>
                          </div>

                          <div className="flex justify-end pt-4">
                            <button
                              onClick={handleFileBuganizer}
                              className="bg-[#1a73e8] hover:bg-blue-700 text-white font-bold px-8 py-4 rounded-2xl shadow-lg shadow-blue-100 transition-all flex items-center justify-center gap-2 group active:scale-95"
                            >
                              Create Issue
                              <ExternalLink className="w-5 h-5 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                            </button>
                          </div>
                        </motion.div>
                      )}

                      {buganizerState === 'filing' && (
                        <motion.div
                          key="buganizer-filing"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          className="flex flex-col items-center py-16 space-y-6"
                        >
                          <div className="relative">
                            <Loader2 className="w-16 h-16 animate-spin text-blue-600" />
                            <Bug className="w-6 h-6 text-blue-400 absolute inset-0 m-auto" />
                          </div>
                          <div className="text-center">
                            <p className="text-xl font-bold text-slate-800">Filing Issue...</p>
                            <p className="text-sm text-slate-500 mt-2">Connecting to Buganizer API</p>
                          </div>
                        </motion.div>
                      )}

                      {buganizerState === 'success' && (
                        <motion.div
                          key="buganizer-success"
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          className="flex flex-col items-center py-12 space-y-8 text-center"
                        >
                          <div className="w-20 h-20 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center shadow-inner">
                            <CheckCircle2 className="w-10 h-10" />
                          </div>
                          <div className="space-y-3">
                            <h3 className="text-2xl font-bold text-slate-800">Issue created successfully</h3>
                            <div className="inline-block px-6 py-3 bg-slate-900 text-white rounded-xl font-mono text-xl font-bold tracking-tight shadow-xl">
                              {filedBugId}
                            </div>
                          </div>
                          <p className="text-slate-500 max-w-xs leading-relaxed">
                            Your Buganizer issue has been created. You can track its progress using the ID above.
                          </p>
                          <button
                            onClick={handleReset}
                            className="px-12 py-4 bg-slate-800 text-white rounded-2xl font-bold text-sm hover:bg-slate-900 transition-all shadow-lg active:scale-95"
                          >
                            Send a new feedback
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                ) : (
                  <div className="mt-8 space-y-3">
                    <div className="flex items-center gap-3 p-4 bg-emerald-50 text-emerald-700 rounded-2xl border border-emerald-100">
                      <CheckCircle2 className="w-5 h-5" />
                      <span className="text-sm font-medium">Feedback submitted successfully.</span>
                    </div>

                    <button
                      onClick={handleReset}
                      className="w-full mt-4 py-4 bg-slate-800 text-white rounded-2xl font-bold text-sm hover:bg-slate-900 transition-all shadow-lg active:scale-95 flex items-center justify-center gap-2"
                    >
                      <PlusCircle className="w-4 h-4" />
                      Send a new feedback
                    </button>
                    
                    {analysis.triage && (
                      <div className={`p-4 rounded-xl text-xs flex items-start gap-3 ${analysis.triage.success ? (analysis.triage.mocked ? 'bg-amber-50 text-amber-700 border border-amber-100' : 'bg-blue-50 text-blue-700 border border-blue-100') : 'bg-red-50 text-red-700 border border-red-100'}`}>
                        <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
                        <div>
                          <p className="font-bold tracking-wider mb-1">Triage status</p>
                          {analysis.triage.success ? (
                            <div className="space-y-3">
                              <div className="flex items-center gap-2 text-emerald-700">
                                <CheckCircle2 className="w-4 h-4" />
                                <p className="font-semibold">
                                  {analysis.triage.mocked ? 'Triage Identified' : 'Action Required'}
                                </p>
                              </div>
                              
                              {analysis.triage.team && (
                                <p className="opacity-80">
                                  This feedback should be routed to the <span className="font-bold">{analysis.triage.team}</span>.
                                </p>
                              )}
                              
                              {analysis.triage.formUrl && (
                                <div className="pt-2">
                                  <a 
                                    href={analysis.triage.formUrl} 
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-all text-sm font-bold tracking-wider shadow-lg hover:shadow-xl active:scale-95"
                                  >
                                    <ExternalLink className="w-4 h-4" />
                                    Open {analysis.triage.team} Form
                                  </a>
                                  <p className="mt-3 text-xs opacity-70 leading-relaxed">
                                    Click the button above to complete the official survey for this team. 
                                    Your summary and justification can be used to help you fill it out.
                                  </p>
                                </div>
                              )}
                              {analysis.triage.mocked && (
                                <p className="text-xs opacity-70 italic">
                                  {analysis.triage.details}
                                </p>
                              )}
                            </div>
                          ) : (
                            <div className="space-y-1">
                              <p className="font-semibold">{analysis.triage.error}</p>
                              <p className="opacity-80">{analysis.triage.details || 'Make sure the destination system is correctly configured.'}</p>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </motion.section>
          )}
        </AnimatePresence>
      </main>

      {/* History Modal */}
      <AnimatePresence>
        {showHistory && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowHistory(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-lg bg-white rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                <h3 className="text-lg font-bold text-slate-800">My Feedback History</h3>
                <button 
                  onClick={() => setShowHistory(false)}
                  className="p-2 hover:bg-slate-200 rounded-full transition-colors"
                >
                  <ChevronRight className="w-5 h-5 rotate-90" />
                </button>
              </div>
              <div className="max-h-[60vh] overflow-y-auto p-4 space-y-2">
                {history.length > 0 ? (
                  history.map((item) => (
                    <div key={item.id} className="p-4 rounded-2xl hover:bg-slate-50 transition-colors border border-transparent hover:border-slate-100 group">
                      <div className="flex justify-between items-start mb-1">
                        <p className="font-semibold text-slate-800 group-hover:text-blue-600 transition-colors">{item.summary}</p>
                        <span className="text-[10px] font-bold text-slate-400">{item.date}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${
                          item.status.includes('Review') ? 'bg-amber-400' : 
                          item.status.includes('Progress') ? 'bg-blue-400' : 'bg-emerald-400'
                        }`} />
                        <p className="text-xs font-medium text-slate-500">{item.status}</p>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="p-12 text-center text-slate-400">
                    <History className="w-12 h-12 mx-auto mb-4 opacity-20" />
                    <p>No feedback submitted in this session.</p>
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
