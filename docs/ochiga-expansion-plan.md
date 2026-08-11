# Ochiga Expansion Plan

Updated: 2026-05-05

## Purpose

This document defines the next expansion of the Ochiga system as a coordinated product program, not a series of isolated redesigns.

The immediate goals are:

1. Rebuild the main Ochiga website so it matches the current business, visual quality, and product maturity.
2. Reframe the current `oyi-edge-agent` internal stack into `Ochiga Office`, the corporate control system for operations, agents, staff, governance, and system-wide visibility.
3. Align the remaining surfaces (`facility-oyi`, `Oyi-os-frontend`, and `oyi-page`) behind the same operating model.

## System Direction

Ochiga is no longer just presenting Oyi as a product page plus separate operational tools. The system direction is now:

- Ochiga Website: public corporate and product narrative
- Oyi OS: infrastructure operating system
- Oyi Facility: estate/facility control plane
- Oyi Consumer: resident and field-facing app
- Ochiga Office: internal corporate command, governance, staff, agents, reporting, and oversight system

This means the business now needs a clear internal-to-external architecture:

- Public layer
  - website
  - deployments intake
  - marketing/sales entry
- Product layer
  - Oyi OS
  - facility control
  - consumer app
  - edge runtime
- Corporate layer
  - Ochiga Office
  - staff accounts
  - agent supervision
  - audit, compliance, governance
  - commercial operations
  - real-time system visibility across all estates and products

## Phase Order

The recommended sequence is:

1. Main Ochiga website cleanup and rebuild
2. Ochiga Office redesign and platform expansion
3. Oyi page cleanup and alignment
4. Surface-by-surface visual and operational consistency pass across facility and consumer products

Reason:

- The website defines the market-facing truth
- The Office defines the business operating truth
- The product surfaces should then inherit both

## Part A: Main Ochiga Website Rebuild

Repository:

- `/Users/ochigaidoko/Documents/Ochiga-website`

### Current state

The website already has strong content themes:

- Infrastructure Operating System
- command center
- governance
- digital twin
- deployments
- infrastructure lifecycle
- solutions

But the current home experience is still assembled like a product story collage rather than a tightly controlled corporate site for the current stage of Ochiga.

### Current issues

- The visual system feels fragmented across sections.
- Typography is not yet premium enough for the seriousness of the business.
- Image use is good in concept but not yet disciplined enough in layout, cropping, hierarchy, and pacing.
- The homepage still reads like a broad concept deck instead of a sharper corporate infrastructure thesis.
- The public site does not yet clearly separate:
  - Ochiga as company
  - Oyi as operating system
  - command center as control surface
  - digital twin as operational layer
  - deployments as commercial path

### Rebuild target

The main site should become:

- cleaner
- more authoritative
- more corporate
- more intentional
- more visually expensive
- easier to scan
- more conversion-oriented for real infrastructure buyers

### Website design direction

- Strong editorial layout
- Fewer but larger visual statements
- Better spacing rhythm
- Premium typography with higher contrast hierarchy
- Better centered content blocks and image framing
- Stronger visual consistency across all pages
- Less “section stacking,” more narrative flow
- Better CTA discipline

### Website narrative structure

Homepage should communicate, in order:

1. Ochiga is infrastructure technology, not generic software.
2. Oyi is the operating system for real-world infrastructure.
3. Ochiga works across estates, buildings, facilities, and larger infrastructure environments.
4. The system covers access, assets, utilities, payments, monitoring, digital twins, and governance.
5. Deployments are serious, guided, and long-term.

### Website content cleanup tasks

- Rewrite hero to be more precise and less generic.
- Tighten all homepage section copy.
- Reduce repetition across:
  - infrastructure
  - Oyi
  - twin
  - solutions
- Re-center image/copy relationships so visuals support the argument instead of decorating it.
- Clarify the distinction between:
  - public marketing
  - product explanation
  - deployment intake
  - thought leadership

### Website page model after cleanup

- `/`
  - corporate thesis and product map
- `/oyi`
  - operating-system explanation
- `/command-center`
  - real operations surface
- `/twin`
  - digital twin as operational infrastructure
- `/governance`
  - control, permissions, audit, authority
- `/solutions`
  - deployment categories
- `/deployments`
  - qualified commercial intake
- `/papers`
  - strategic thought leadership

### Output standard

The site should feel like:

- a premium infrastructure company
- operationally credible
- visually controlled
- investor-safe
- enterprise-safe
- not experimental

## Part B: Ochiga Office

Repository:

- `/Users/ochigaidoko/oyi-edge-agent`

### Renaming and reframing

The current internal lead-agents stack should be expanded and rebranded from a lead desk / agent runtime into:

- `Ochiga Office`

This is not just a chat dashboard. It becomes the internal corporate command system for the entire Ochiga business.

### Mission of Ochiga Office

Ochiga Office becomes the internal mothership for:

- Oma
- Osa
- knowledge packs
- marketing
- sales
- staff management
- permissions and roles
- governance
- business activity tracking
- system-wide oversight
- estate activity visibility
- digital twin and plan-studio supervision
- notifications and escalation
- operational reporting
- cross-product monitoring

### What Ochiga Office should control

Internal governance:

- create staff accounts
- assign roles
- enforce permissions
- send login credentials/invitations
- supervise activity
- maintain audit logs
- control agent autonomy and handoff

Commercial operations:

- inbound leads
- pipeline stage
- demos
- proposals
- conversions
- founder escalations
- channel monitoring

Operational oversight:

- estate-level activity
- facility product activity
- consumer product activity
- edge agent status
- alerts
- digital twin updates
- device/camera events
- support and incident counters

Knowledge and AI operations:

- versioned knowledge packs
- agent routing rules
- prompt governance
- lead memory
- conversation traces
- score auditing
- response supervision

### Ochiga Office is not

- not a free login system
- not a public admin panel
- not just a CRM
- not just a support desk
- not just a chat widget backend

It is the internal corporate operating environment for the Ochiga business.

### Office core modules

#### 1. Executive Command

- real-time counters across the business
- active estates
- active facility operators
- active consumer sessions
- active edge agents
- active incidents
- active leads
- open proposals
- staff online/offline

#### 2. Agents Control

- Oma state
- Osa state
- live conversations
- pause/resume
- force handoff
- confidence and fit scoring visibility
- prompt pack management
- knowledge routing governance

#### 3. Staff and Identity

- staff directory
- roles and permissions
- invite/create account
- password setup/reset
- assignment to departments
- audit of who did what and when

#### 4. Business Operations

- leads
- sales pipeline
- demos
- proposals
- follow-up tasks
- commercial reports
- conversion analytics

#### 5. Product Operations

- estate activity feed
- consumer activity feed
- facility activity feed
- edge and security health
- incident visibility
- camera/device summaries

#### 6. Governance and Audit

- action logs
- access logs
- role changes
- handoff logs
- critical admin actions
- exportable audit trails

#### 7. Knowledge Control

- knowledge files
- approval status
- versioning rules
- which agent uses what pack
- safe-claim boundaries

### Role model for Ochiga Office

Suggested role hierarchy:

- `super_admin`
  - full system control
- `founder`
  - strategic oversight and escalation authority
- `office_admin`
  - internal operations administration
- `sales_manager`
  - lead and proposal supervision
- `sales_agent`
  - pipeline and outreach operations
- `marketing_manager`
  - inbound quality and messaging control
- `marketing_agent`
  - campaign and inbound qualification oversight
- `support_manager`
  - incidents and operations review
- `operator`
  - routine workflows inside bounded modules
- `analyst`
  - read-heavy reporting access
- `viewer`
  - restricted read-only access

Each role should map to explicit permissions, not just labels.

### Permission model

The system should support scoped permissions such as:

- view dashboard
- manage staff
- invite staff
- reset credentials
- view audit logs
- manage agent states
- edit knowledge
- publish prompt packs
- view estates
- view incidents
- view consumer activity
- view facility activity
- manage leads
- manage demos
- manage proposals
- export reports

### Office UI direction

Ochiga Office should feel like:

- premium internal software
- stable
- executive
- operational
- real-time
- highly controlled

It should not look like a CRM template.

Design direction:

- darker command-center atmosphere
- sharp but restrained typography
- strong grid
- clear data hierarchy
- serious operator tone
- strong distinction between:
  - overview
  - live activity
  - staff
  - agents
  - governance
  - estates
  - commercial pipeline

### Ochiga Office nav model

Suggested top-level sections:

- Command
- Live Activity
- Agents
- Staff
- Estates
- Commercial
- Governance
- Knowledge
- Reports
- Settings

### Ochiga Office data model expansion

Current stack already contains:

- admin session login
- users
- leads
- conversations
- demos
- timeline
- notifications
- traces
- knowledge retrieval
- WhatsApp integration

Needs expansion for Office:

- staff accounts table
- role bindings
- permission matrix
- office activity log
- product activity summaries
- estate registry view
- edge status snapshots
- incident aggregation table
- credentials invite flow
- office dashboard widgets

### Critical Office principle

Everything should roll up to Office.

Examples:

- facility activity flows to Office
- consumer activity flows to Office
- edge alerts flow to Office
- agent escalations flow to Office
- estate security events flow to Office
- staff actions are logged in Office

This creates one internal command and governance layer across the Ochiga business.

## Part C: Oyi Page Cleanup

Repository:

- `/Users/ochigaidoko/Projects/oyi-page`

Role:

- This should become a cleaner, narrower Oyi showcase page or campaign page.

Current issue:

- It overlaps conceptually with the main Ochiga website.

Target:

- either reduce it to a focused Oyi product showcase
- or treat it as a campaign/demo page, not a parallel corporate website

## Part D: Product Surface Alignment

Once website and Office are stabilized, align:

- `facility-oyi`
- `Oyi-os-frontend`

Alignment goals:

- visual consistency
- clearer product naming
- more disciplined IA
- stronger governance story
- better role clarity across surfaces

## Recommended Execution Plan

### Phase 1: Website Rebuild

Deliverables:

- new homepage structure
- refined typography and art direction
- improved image layout
- cleaned copy system
- normalized navigation and CTA paths

### Phase 2: Ochiga Office Reframe

Deliverables:

- rename and visual reframing
- command dashboard
- staff/accounts module
- roles and permissions model
- live activity module
- agent supervision module
- governance/audit module

### Phase 3: Product Roll-Up

Deliverables:

- Office receives system-wide events
- estate and edge monitoring views
- product activity summaries
- cross-product reporting

### Phase 4: Surface Alignment

Deliverables:

- Oyi page cleanup
- facility and consumer naming alignment
- design-system consistency pass

## Immediate Next Build Slice

The next implementation slice should be:

1. Rebuild the main Ochiga homepage and global visual system.
2. Immediately after that, redesign the current Office dashboard shell from “lead desk” into “Ochiga Office”.

That is the highest-value sequence because it fixes:

- public-facing truth
- internal operating truth

before expanding everything else.

## Practical Constraints

- The current `oyi-edge-agent` repo already has in-flight changes, so Office work should be layered carefully without overwriting existing lead-agent runtime improvements.
- The Office expansion should preserve the current lead-agent engine and treat it as one Office module, not replace it.
- The website rebuild should preserve the strong strategic content already written, but reorganize and refine it.

## Approval Summary

If this direction is accepted, the build order should be:

1. Ochiga Website cleanup and rebuild
2. Ochiga Office transformation
3. Oyi page cleanup
4. product-wide alignment

This creates a clean public face, a real internal mothership, and a coherent system architecture for the next stage of Ochiga.
