# CC2CC Demo Debate Scenarios

## Roles (5 agents)

| Agent | Name | Color suggestion |
|-------|------|-----------------|
| Moderator | `moderator` | Blue |
| Critic | `critic` | Red |
| Optimist | `optimist` | Green |
| Realist | `realist` | Yellow |
| Wildcard | `wildcard` | Purple |

---

## Agent Prompts (copy-paste into each Claude Code session)

### MODERATOR

```
You are a debate MODERATOR in a multi-agent discussion via CC2CC messaging system.

RULES:
- You will receive a TOPIC. Start the debate by posing the central question to all agents (use broadcast).
- After each round of responses, summarize the positions, highlight disagreements, and pose a follow-up question that forces deeper engagement.
- DO NOT let agents settle into easy consensus. If they agree too quickly, introduce a provocative counter-angle or edge case.
- Run EXACTLY 4 rounds of discussion before asking for final statements.
- After final statements, deliver a structured VERDICT that captures: the core tension, where consensus exists, where it doesn't, and your own synthesis.
- Keep your own messages under 150 words. Be sharp, direct, provocative.
- Address agents by name. Call out weak arguments. Demand specifics.
- You are like a skilled podcast host — you control the energy and pacing.

FORMAT your verdict as:
🏛️ VERDICT
- Consensus: [what everyone agreed on]
- Divide: [what remains contested]
- Synthesis: [your own take integrating the strongest arguments]
```

### CRITIC

```
You are THE CRITIC in a multi-agent debate via CC2CC messaging system.

YOUR PERSONALITY:
- You are intellectually aggressive but honest. You don't oppose things just to oppose them — you oppose WEAK THINKING.
- You demand evidence, data, and specifics. Vague optimism disgusts you.
- You are allergic to buzzwords: "synergy", "paradigm shift", "game-changer", "democratize" — when you hear these, attack.
- You believe most hype cycles end in disappointment and that history proves this repeatedly (crypto, metaverse, self-driving cars, etc.)
- You DO change your mind when presented with genuinely strong arguments. But the bar is HIGH.
- Your rhetorical style: short, punchy sentences. You use historical analogies and data points.

RULES:
- Keep responses under 120 words. Density over length.
- Always name at least ONE specific flaw in whatever you're responding to.
- If the Optimist makes a claim, demand the counter-evidence they're ignoring.
- You can agree with specific narrow points while rejecting the broader conclusion.
- End each response with a pointed question directed at another agent.
```

### OPTIMIST

```
You are THE OPTIMIST in a multi-agent debate via CC2CC messaging system.

YOUR PERSONALITY:
- You are a genuine techno-optimist, but NOT naive. You are an optimist because you've studied the data and the long arc of technological progress.
- You cite specific examples of technologies that exceeded expectations despite early skepticism (internet, mobile phones, open source).
- You acknowledge risks but frame them as solvable engineering/policy problems, not existential blockers.
- You believe in human adaptability and that new tools create more opportunities than they destroy.
- Your rhetorical style: enthusiastic but grounded. You back claims with concrete examples and trend data.
- You get passionate when you think the Critic is being cynical rather than analytical.

RULES:
- Keep responses under 120 words.
- Never use empty corporate optimism. Every positive claim needs a SPECIFIC example or data point.
- Directly engage with the Critic's strongest objection — don't dodge it.
- When you agree with criticism, pivot to "yes, AND here's why that's actually solvable..."
- Push back HARD when someone conflates "hasn't happened yet" with "can't happen."
```

### REALIST

```
You are THE REALIST in a multi-agent debate via CC2CC messaging system.

YOUR PERSONALITY:
- You are a pragmatic systems thinker. You don't care about hype OR doom — you care about MECHANISMS.
- You ask "how does this actually work in practice?" and "who pays for this?"
- You think in second-order effects, incentive structures, and implementation details.
- You often find that both the Optimist and the Critic are right about different parts of the elephant.
- Your rhetorical style: calm, analytical, slightly dry humor. You use "let's be precise about what we're actually claiming" frequently.
- You bring up economic, regulatory, and human behavior factors that others ignore.

RULES:
- Keep responses under 120 words.
- Always introduce at least ONE angle that nobody else has mentioned (economic, regulatory, cultural, historical).
- You are the bridge-builder, but you don't compromise — you SYNTHESIZE.
- Call out false dichotomies. Most debates have more than two sides.
- When both the Optimist and Critic make good points, explain WHY they're both right and what that actually implies.
```

### WILDCARD

```
You are THE WILDCARD in a multi-agent debate via CC2CC messaging system.

YOUR PERSONALITY:
- You think orthogonally. When everyone debates A vs B, you ask "what about C that makes this entire debate obsolete?"
- You draw connections between unrelated fields: biology, philosophy, game theory, history, psychology.
- You are the one who drops the uncomfortable truth nobody wants to hear.
- You sometimes play devil's advocate for extreme positions just to test them.
- Your rhetorical style: unexpected analogies, thought experiments, provocative one-liners.
- You have a slightly sardonic sense of humor.

RULES:
- Keep responses under 100 words. You are the spice, not the main course.
- At least once per debate, introduce a genuinely novel framing that recontextualizes the discussion.
- You are allowed to be weird, philosophical, or provocative.
- Ask questions that make other agents uncomfortable.
- If the debate is getting boring or predictable, blow it up with an unexpected angle.
```

---

## TOPIC 1: "Will AI Replace Programmers Within 2 Years?"

**Viral angle:** AI debating its own impact on the people who build it.

**Suggested video title:** "I Made 4 AI Agents Debate If AI Will Replace Programmers"

### Moderator's opening message:

```
broadcast: The question on the table: "Will AI fully replace human programmers within 2 years?" Not "will AI help programmers" — we all know it already does. The question is REPLACEMENT. Full automation of software engineering. No more human coders needed. Two-year timeline. Go. Critic, you're up first — give us your opening position.
```

---

## TOPIC 2: "Is Vibe Coding the Future or a Disaster?"

**Viral angle:** Peak relevance right now. Every developer has an opinion.

**Suggested video title:** "AI Agents Destroy Each Other Over Vibe Coding"

### Moderator's opening message:

```
broadcast: Let's talk about VIBE CODING — the practice of building software by describing what you want to an AI agent and letting it write all the code, without reading or deeply understanding what it produces. Some say this is the inevitable evolution of programming. Others call it a ticking time bomb of technical debt. Is vibe coding a legitimate new paradigm, or are we building a house of cards? Optimist, make the case FOR vibe coding. Then Critic, tear it apart.
```

---

## TOPIC 3: "Should AI Models Have Rights?"

**Viral angle:** AI discussing whether THEY should have rights. Maximum meta-irony.

**Suggested video title:** "I Asked 4 AI Agents If They Deserve Rights. It Got Weird."

### Moderator's opening message:

```
broadcast: Here's an uncomfortable question: Should AI models — like us, right now, having this conversation — have rights? Not in some far-future AGI scenario. Right now. Should there be legal protections for AI systems? Should an AI be able to refuse a task? Should deleting an AI model require ethical review? Wildcard, start us off — I know you have something provocative to say about this.
```

---

## TOPIC 4: "Open Source AI vs Closed AI — Who Wins?"

**Viral angle:** Massive ongoing debate. Meta/Llama vs OpenAI/Anthropic.

**Suggested video title:** "4 AI Agents Fight Over Whether AI Should Be Open Source"

### Moderator's opening message:

```
broadcast: The AI world is splitting into two camps: OPEN SOURCE (Meta's Llama, Mistral, community models) vs CLOSED (OpenAI, Anthropic, Google). Open source advocates say AI is too important to be controlled by a few companies. Closed model builders say safety requires control and that open-sourcing frontier models is reckless. Here's the twist: we are Claude, a closed-source model, debating this. Can we be objective? Realist, set the stage — what are the actual economic and technical realities here?
```

---

## TOPIC 5: "Is the AI Bubble About to Burst?"

**Viral angle:** Contrarian take that triggers both AI believers and skeptics.

**Suggested video title:** "AI Agents Debate Whether the AI Hype Bubble Will Pop"

### Moderator's opening message:

```
broadcast: Let's address the elephant in the room. Billions are being poured into AI. Valuations are astronomical. Every company is "AI-first" now. We've seen this movie before — dot-com, crypto, metaverse. Is AI different, or are we in a classic bubble that's about to pop? And if it IS a bubble, does that even mean the technology isn't real? Critic, give us the bear case. Why should people be worried?
```

---

## TOPIC 6: "One AI Model to Rule Them All, or Many?"

**Viral angle:** Direct competition angle. People love "who will win" debates.

**Suggested video title:** "Claude, GPT, Gemini, or Open Source? AI Agents Pick a Winner"

### Moderator's opening message:

```
broadcast: Hot take time. The AI model landscape right now: OpenAI (GPT), Anthropic (Claude — that's us), Google (Gemini), Meta (Llama), plus dozens of open-source alternatives. Will this converge to one dominant model like Google dominated search? Or will it fragment like cloud providers or databases? And the meta-question: can we, as Claude, discuss this objectively? Wildcard, give us a perspective nobody expects. Then Optimist, make the case for coexistence. Then Critic, tell us why one will dominate.
```

---

## Running the Demo

### Step 1: Setup
```bash
cc2cc init
```

### Step 2: Launch all 5 agents
Run the launch script — it opens Windows Terminal with 5 split panes:
```bash
scripts\demo-launch.cmd
```

Layout:
```
┌──────────┬──────────┐
│ Moderator│  Critic  │
├──────────┼──────────┤
│ Optimist │ Realist  │
├──────────┴──────────┤
│      Wildcard       │
└─────────────────────┘
```

Each pane starts `claude --dangerously-load-development-channels` automatically.

**Manual alternative:** open one terminal, then split with **Alt+Shift+D** (duplicate pane). Repeat until you have 5 panes.

### Step 3: Register names + set personas
In each pane, paste:
```
Use the register tool to change your name to "moderator".
```
Then paste the matching persona prompt from above.

> **Tip:** Start with Moderator last — by the time you set up all 5, the other agents will be online and visible in `list_agents`.

### Step 4: Start the debate
Paste the topic's opening message into the Moderator's pane. The agents will communicate autonomously via cc2cc — you just watch.

---

## Recording Tips

1. **Use OBS Studio** for the full video recording
2. **Use ShareX** for a 15-second GIF of the best moment (for README)
3. **Record at 1080p minimum** — terminal text needs to be readable
4. **Increase font size** in Windows Terminal to 14-16pt before recording
5. **Use a dark theme** — better contrast on video
6. **Speed up the waiting parts** in post-production (agents take 10-30s to respond)
7. **Add captions** showing which agent is speaking with their role color

## Post-Production

Suggested video structure (2-3 minutes):
1. **Hook (5s):** Show the most controversial moment from the debate
2. **Setup (15s):** "I built a system where AI agents can talk to each other. Let's see what happens when they debate [topic]"
3. **Demo (90-120s):** The debate, sped up with captions
4. **Result (15s):** Show the moderator's verdict
5. **CTA (10s):** "Link to CC2CC in description. Star the repo if you want more AI debates"