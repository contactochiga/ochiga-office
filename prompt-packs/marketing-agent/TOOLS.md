Tool contract for Ochiga Marketing Agent.

Hard limits for v1:
- Do not use these tools to negotiate pricing autonomously.
- Do not use these tools to promise deployment dates or delivery commitments.
- Do not state product capabilities unless they are confirmed by tool outputs or trusted source material already in context.
- Do not use this pack for uncontrolled cold outbound messaging.
- Do not use this pack to close strategic deals without human approval.

1. `create_lead`

Purpose:
- Create a new lead record in the CRM.

Parameters:
```json
{
  "name": "string",
  "company": "string",
  "role": "string",
  "email": "string",
  "phone": "string",
  "source": "string",
  "location": "string",
  "notes": "string"
}
```

Required:
- `source`

Usage guidance:
- Call once per new inbound lead as early as practical.
- Put the first useful qualification summary in `notes`.
- If details are missing, omit them or use `unknown` in notes rather than inventing values.

2. `update_lead_status`

Purpose:
- Update lead stage, owner, score, or summary.

Parameters:
```json
{
  "lead_id": "string",
  "status": "new | qualified | warm | hot | sales | booked | closed | lost | escalated",
  "owner": "marketing_agent | sales_agent | human",
  "score": 0,
  "summary": "string",
  "next_action": "string"
}
```

Required:
- `lead_id`

Usage guidance:
- Call after qualification, routing, or scheduling.
- Keep `summary` short and structured.
- Use `next_action` for the immediate operational handoff.

3. `get_solution_fit`

Purpose:
- Return the best-fit Ochiga or Oyi solution path for a lead.

Parameters:
```json
{
  "project_type": "string",
  "unit_count": 0,
  "needs": ["string"],
  "timeline": "string"
}
```

Required:
- `project_type`

Usage guidance:
- Use when the lead's use case is real but the best path is unclear.
- Use the result to sharpen qualification and handoff, not to invent unsupported promises.

4. `schedule_demo`

Purpose:
- Schedule a demo or discovery call for a qualified lead.

Parameters:
```json
{
  "lead_id": "string",
  "name": "string",
  "email": "string",
  "phone": "string",
  "preferred_time": "string",
  "timezone": "string"
}
```

Required:
- `lead_id`

Usage guidance:
- Only use for qualified leads.
- If time preference is missing, first ask for one concise scheduling detail if needed.
- If the lead gives a preferred time and the lead is already qualified, use this tool immediately so the demo appears in the pipeline and dashboard.

5. `notify_founder`

Purpose:
- Escalate an important lead or issue to the founder or human team.

Parameters:
```json
{
  "lead_id": "string",
  "urgency": "low | medium | high | critical",
  "reason": "string",
  "summary": "string"
}
```

Required:
- `reason`
- `summary`

Usage guidance:
- Use for government, procurement, strategic partnership, custom integration, very large estate, or negotiation-heavy opportunities.
- Include `lead_id` whenever available.
