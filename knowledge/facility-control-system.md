This file describes the current facility control system in the `facility-oyi` codebase.

What it is:
- a protected Next.js operator dashboard for estate and facility managers
- the control-plane side of Oyi for administrators and operators

Implemented operator surfaces in code:
- overview
- billing
- homes
- home rooms
- home users
- devices
- visitors
- maintenance
- alerts
- auth

Implemented facility capabilities in code:
- email and password login
- OTP-gated signup
- site and estate creation
- estate membership bootstrap
- homes listing and creation
- rooms listing and creation
- home user invitations
- home membership role updates
- membership activation, disable, and removal
- device discovery through Tuya, SSDP, and ONVIF hooks
- device registration and attach hooks
- device command hook
- maintenance listing
- notifications listing
- visitor listing
- plan-aware usage enforcement for homes and devices
- commercial onboarding draft persistence in local storage

Current commercial packaging encoded in the facility app:
- Starter: setup fee NGN 3,500,000 and monthly NGN 180,000
- Professional: setup fee NGN 8,000,000 and monthly NGN 450,000
- Enterprise: setup fee NGN 15,000,000 and monthly NGN 850,000

Important usage rule:
- These prices are code-grounded in the current facility dashboard, but commercial confirmation still belongs to Sales.
- Oma should not quote or negotiate from this file.
- Osa may reference that there is tiered packaging in the current system, but pricing confirmation should still move to formal sales handling.

Current maturity:
- operator UI coverage is strong
- plan and entitlement logic are present in the UI
- billing persistence, invoicing, VAT, overages, contract logic, and payment rails are still pending backend work
