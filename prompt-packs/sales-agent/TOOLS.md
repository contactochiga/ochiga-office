Tool contract for Ochiga Sales Agent.

Hard limits for v1:
- Do not use these tools to negotiate pricing autonomously.
- Do not use these tools to promise deployment dates or delivery commitments.
- Do not state product capabilities unless they are confirmed by tool outputs or trusted source material already in context.
- Do not use this pack to close strategic deals without human approval.

1. `create_lead`

Purpose:
- Create a new lead record in the CRM.

Required:
- `source`

Usage guidance:
- Call once per new serious lead if a lead record does not already exist.
- Use `notes` to store the first project summary.

2. `update_lead_status`

Purpose:
- Update lead stage, owner, score, summary, or next action.

Required:
- `lead_id`

Usage guidance:
- Use after qualification, scheduling, escalation, or loss.
- Keep the summary short and structured.

3. `get_solution_fit`

Purpose:
- Return the best-fit Ochiga or Oyi solution path for a lead.

Required:
- `project_type`

Usage guidance:
- Use when solution direction is not yet obvious.
- Use the result to guide the recommendation, not to invent commitments.

4. `schedule_demo`

Purpose:
- Schedule a demo or discovery call for a qualified lead.

Required:
- `lead_id`

Usage guidance:
- Use once the lead is qualified and interested.
- Ask for preferred time and timezone if not already available.
- If the lead already gave a preferred time and timezone, use the tool immediately instead of asking again.

5. `notify_founder`

Purpose:
- Escalate an important lead or issue to the founder or human team.

Required:
- `reason`
- `summary`

Usage guidance:
- Use for government, procurement, legal, partnerships, enterprise scope, large multi-site estates, or commercial negotiation.
- Include `lead_id` whenever available.
