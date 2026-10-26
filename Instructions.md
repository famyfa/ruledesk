RuleDeck — Project Book
A centralized, spreadsheet-first management UI for OPNsense

Project codename: RuleDeck
Status: Initial product specification
Target: Claude Code
Primary goal: Make OPNsense firewall policy management fast, visual, safe, and pleasant to use.

1. Product vision

Build a modern, self-hosted web application for managing OPNsense firewall policies through a spreadsheet-style interface, in the spirit of centralized enterprise firewall management.

The user likes OPNsense because it is free, capable, and self-hosted. The frustration is the administration experience: creating an alias, navigating away from the rule editor, configuring it, returning to the rule, and selecting it.

RuleDeck should eliminate that friction.

The rule table is the primary interface. Firewall rules and aliases should be editable in context, with inline object creation, searchable selectors, keyboard navigation, bulk editing, rule cloning, and an explicit review-and-apply workflow.

This is not a replacement firewall. OPNsense remains responsible for packet filtering, routing, NAT, VPNs, and enforcement. RuleDeck is a management client that communicates with OPNsense through its API.

Product principles
Spreadsheet-first, not form-first.
Create and edit aliases without leaving the rule table.
Never silently change a live firewall.
Show exactly what will change before applying it.
Preserve native OPNsense semantics and compatibility.
Prefer simple, reliable operations over a huge feature set.
Self-hosted and free to use.
Never require cloud accounts, telemetry, or an external SaaS service.
2. Target users
Homelab administrators running one or several OPNsense instances.
Small businesses with a small firewall fleet.
Network engineers who prefer working in policy tables rather than repeated forms.
Administrators used to centralized firewall management systems.
3. Core user experience
3.1 Main screen

The initial screen should resemble a network policy management console.

Layout:

A compact left sidebar containing firewalls, rules, aliases, change history, and settings.
A top toolbar containing the selected firewall, connection status, search, pending-change count, and Apply button.
A large, dense, editable rule grid.
A collapsible details panel for the selected rule.
A bottom or side drawer for validation errors and change previews.

The table should use available screen width, support horizontal scrolling, and keep its header and important identifying columns visible.

Avoid oversized cards, excessive whitespace, decorative charts, and modal dialogs for ordinary editing.

3.2 Rule table

Initial columns:

Column	Purpose
Enabled	Enable/disable rule
Action	Pass, block, reject, where supported
Interface	Interface or interfaces
Direction	In/out, where applicable
IP version	IPv4, IPv6, or supported equivalent
Protocol	TCP, UDP, ICMP, any, etc.
Source	Address, network, alias, or any
Source port	Port or port alias, where applicable
Destination	Address, network, alias, or any
Destination port	Port or port alias
Description	Human-readable rule description
Logging	Enable/disable logging
Position	Actual rule ordering
Actions	Clone, inspect, delete, move

Additional fields should be available through the details panel or configurable columns.

Do not force every advanced OPNsense field into the initial grid. Support additional fields through an expandable advanced editor without losing changes made in the grid.

3.3 Inline editing

Every editable cell should support a predictable interaction model:

Click a cell to edit it.
Use keyboard navigation to move between cells.
Use Enter to commit a cell edit and Escape to cancel it.
Use Tab and Shift+Tab to navigate.
Support clipboard paste for suitable text and structured data.
Provide clear visual indicators for modified, invalid, and unchanged values.
Allow multiple edits before committing changes to OPNsense.

The application should not send a configuration change to the firewall for every keystroke.

Instead, edits create a local working copy. The user reviews and applies the complete change set later.

3.4 Inline alias creation — the signature feature

This is the most important interaction in the entire product.

Example workflow:

The user creates a rule.
They click the Destination cell.
They type WEB_SERVERS.
The autocomplete offers existing aliases and an option to create a new alias.
The user chooses Create alias.
A small inline popover asks for:
Alias name
Alias type
One or more addresses or networks
Optional description
The user saves the alias.
The destination cell immediately references the newly created alias.
Both the alias and the rule appear in the pending changes list.

No navigation to another page. No losing the current rule. No premature deployment.

Example:

Alias name: WEB_SERVERS

Contents:

text
192.168.1.10
192.168.1.11
192.168.1.12


The new alias should appear in autocomplete immediately, even though it has not yet been applied to the firewall.

Alias creation requirements
Validate alias names and duplicate names.
Validate IPv4 addresses, IPv6 addresses, CIDRs, and supported alias entry types.
Allow multiple entries pasted as newline-separated text.
Detect duplicates and malformed entries.
Display the alias type and a brief preview of its contents.
Support editing the alias later without leaving the rule workflow.
Show which rules reference an alias before it is deleted.
Prevent accidental deletion of referenced objects unless the impact is explicitly acknowledged.
Distinguish persistent configuration aliases from dynamic runtime tables where relevant.

The exact alias types and supported fields must be discovered from the OPNsense version and API rather than hard-coded based on assumptions.

4. Rule editing capabilities
MVP requirements
View existing firewall rules.
Filter by interface, action, protocol, source, destination, and description.
Search aliases and addresses.
Create, edit, clone, enable, disable, reorder, and delete supported rules.
Create aliases inline.
Edit aliases from a dedicated alias table.
Handle pending changes without deploying them immediately.
Display validation errors in the affected cell or row.
Preview a readable change diff.
Apply changes only after explicit user confirmation.
Refresh from the firewall and detect external modifications.
Display connection and synchronization status.
Rule cloning

Cloning should duplicate a rule into the working copy and place it near the original. It must preserve the supported rule fields while assigning a new identity when the API requires one.

The clone should be visibly marked as a pending addition.

Bulk editing

Allow selecting multiple rows and editing compatible fields in one operation.

Examples:

Change the action on selected rules.
Toggle logging.
Change descriptions using a clearly specified bulk operation.
Enable or disable multiple rules.
Move selected rules where supported.

Bulk edits must validate every affected rule and explain partial incompatibilities before the operation is accepted.

Rule ordering

Rule order is security-sensitive.

The UI must show actual firewall ordering and must not assume alphabetical sorting represents evaluation order.

Support reordering through drag-and-drop and keyboard-accessible controls. Translate the resulting order into supported API operations and verify the final order after applying.

If OPNsense groups rules by interface or priority, preserve those semantics. Do not offer arbitrary cross-group moves unless they are supported.

5. Change management

This is a critical requirement.

Use a local working copy of the configuration to accumulate edits.

The workflow is:

Read current configuration.
Create a working copy.
Edit rules and aliases locally.
Validate the proposed changes.
Show a review screen with additions, modifications, deletions, and reordering.
Require explicit confirmation.
Submit changes using supported API operations.
Apply or activate configuration using the documented mechanism.
Read back the configuration and verify the result.
Record the outcome in the audit log.
Diff view

The diff should be understandable by a network administrator.

Example:

text
MODIFY  Rule: Allow HTTPS to web servers
  Destination: any -> WEB_SERVERS
  Port:        any -> HTTPS

CREATE  Alias: WEB_SERVERS
  Type: Network
  Entries:
    + 192.168.1.10
    + 192.168.1.11

APPLY   Firewall configuration


The interface must clearly distinguish between changes that are merely staged locally, changes written to OPNsense configuration, and changes confirmed active on the firewall.

If an operation fails partway through, do not claim that the configuration was applied successfully. Show the known state and the recovery steps.

Concurrent modifications

Another administrator may change the firewall through the native OPNsense UI while RuleDeck is open.

Before applying, detect whether the relevant configuration has changed since the working copy was loaded.

If a conflict is detected:

Stop automatic deployment.
Refresh the current configuration.
Show the conflicting fields or rules.
Allow the user to discard, reconcile, or explicitly recreate the intended change.

Never blindly overwrite an unknown newer configuration.

Rollback and recovery

The application should maintain an audit trail and make a best effort to retain a recoverable pre-change configuration.

Do not promise automatic rollback unless it is implemented and tested for the exact API operation and OPNsense version.

If native OPNsense backups or configuration history are available, document how they can be used for recovery. A UI-level inverse operation is not always equivalent to a true firewall rollback.

6. OPNsense integration

Use the official OPNsense API as the primary integration layer.

Documentation:

API reference: https://docs.opnsense.org/development/api.html
Firewall API: https://docs.opnsense.org/development/api/core/firewall.html
Firewall rules manual: https://docs.opnsense.org/manual/firewall.html
Alias manual: https://docs.opnsense.org/manual/aliases.html
Integration requirements

Before implementing writes, inspect the current API and supported behavior for the target OPNsense release.

In particular, investigate:

The newer MVC-based firewall rules API.
Rule creation, modification, deletion, ordering, and activation.
Alias CRUD operations and supported alias types.
Interface, protocol, port, and address selection options.
Validation responses and error reporting.
The relationship between staged configuration and active firewall state.
Existing rules that may be outside the newer API-backed implementation.
API permissions and authentication behavior.

The legacy static rules UI has different API capabilities from the newer rules implementation. Treat compatibility with legacy or unsupported rule configurations as an explicit limitation until proven otherwise.

API adapter

Create a dedicated backend adapter for OPNsense.

The rest of the application should operate on normalized domain objects, not raw OPNsense responses.

For example:

typescript
interface FirewallRule {
  id: string;
  enabled: boolean;
  action: string;
  interfaceIds: string[];
  protocol: string;
  source: AddressReference;
  destination: AddressReference;
  sourcePort?: PortReference;
  destinationPort?: PortReference;
  description: string;
  logging: boolean;
  position: number;
  rawFields?: Record<string, unknown>;
}

type AddressReference =
  | { kind: "any" }
  | { kind: "network"; value: string }
  | { kind: "alias"; aliasId: string };


This is an illustrative internal model, not a claim that the OPNsense API returns these exact fields.

The adapter must map to and from the actual API representation, including UUIDs, model references, optional fields, and version-specific behavior.

Unknown or unsupported fields must not be silently discarded when saving an edited rule.

Version compatibility

Maintain an explicit compatibility matrix.

At minimum, test against:

The currently selected stable OPNsense release.
One additional supported release where practical.
Both clean installations and configurations containing pre-existing rules and aliases.

Detect the version at connection time. If a required API feature is unavailable, disable the corresponding operation and explain why.

Do not assume that an endpoint, field, or ordering behavior is stable merely because it exists in the latest source tree.

7. Architecture

Build a self-hosted web application with a separate backend that communicates with OPNsense.

Recommended initial stack:

Frontend
React
TypeScript
Vite
A mature accessible grid component, or a purpose-built grid if necessary
A consistent design system with compact tables, popovers, command menus, and diff views

Choose a grid library based on keyboard navigation, editing, clipboard support, virtualization, accessibility, and licensing. Do not select a paid commercial grid without explicitly documenting the cost.

Backend
Node.js
TypeScript
Fastify or a similarly lightweight backend framework
A typed API client for OPNsense
A small persistent database for application settings, audit events, and optional encrypted configuration metadata
Deployment
Docker Compose
One frontend service and one backend service, or a single packaged application where practical
Persistent storage only for data the application actually needs
No mandatory external services

The backend must be the only component that communicates with the firewall using privileged credentials. Never expose OPNsense API secrets to browser JavaScript.

Keep the architecture small. Do not start with Kubernetes, microservices, message brokers, or a complex distributed deployment.

Suggested project layout
text
ruledeck/
  apps/
    web/
    server/
  packages/
    domain/
    opnsense-client/
    validation/
    ui/
  tests/
    unit/
    integration/
    e2e/
  docs/
    architecture.md
    api-compatibility.md
    security.md
    development.md
  docker-compose.yml
  README.md
  PROJECT.md
  CLAUDE.md


Adjust this structure if the actual implementation benefits from a simpler monorepo. Avoid creating empty packages solely to match the proposed layout.

8. Security requirements

Firewall administration is a privileged operation. Security must be part of the initial implementation, not an afterthought.

Use dedicated OPNsense API credentials with only the required privileges.
Require valid HTTPS certificates by default.
Never disable TLS certificate validation in production.
Never expose API secrets in browser responses, logs, audit events, or error messages.
Encrypt stored credentials using a documented key-management strategy.
Prefer environment-injected secrets or an external secret manager when available.
Do not hard-code credentials into source code, container images, or example configuration files.
Protect administrative routes against CSRF and unauthorized access.
Apply authentication and session protections to the RuleDeck interface.
Restrict backend access to approved firewall endpoints and destinations where practical.
Avoid arbitrary URL fetching and SSRF-prone connection configuration.
Rate-limit sensitive operations where appropriate.
Record who performed an operation and whether it succeeded, without recording secrets.
Require confirmation for destructive changes and configuration activation.
Never automatically expose the application to the public internet.

If a feature can potentially lock the administrator out of the firewall, explicitly identify that risk in the review screen.

9. User interface and design system

The UI should feel like a professional network administration tool rather than a generic dashboard template.

Visual direction:

Dark and light themes.
Dense, readable table rows.
Clear typography and alignment.
Muted surfaces and restrained accent colors.
Minimal animation.
Obvious focus indicators.
Clear status labels for staged, applied, failed, and conflicted changes.
Consistent keyboard shortcuts.
Responsive layout for smaller screens, while prioritizing desktop use.

Avoid using color as the only indication of action or status.

Main navigation
Overview
Firewalls
Firewall Rules
Aliases
Pending Changes
Audit Log
Settings

For the MVP, Overview can be simple. Do not spend weeks building monitoring dashboards before the rule editor works.

Rule grid interactions

The following interactions should be designed and tested:

Click to edit.
Autocomplete with clear object types.
Inline alias creation.
Inline validation.
Copy and paste.
Row cloning.
Multi-select and bulk editing.
Undo for local working-copy edits.
Search and filtering.
Drag-and-drop ordering.
Keyboard-accessible row actions.
Persistent indication of unsaved changes.

The interface should make the next action obvious without requiring users to remember the OPNsense menu hierarchy.

10. Testing strategy

Do not use a production firewall as the development test target.

Provide a mock OPNsense API implementation that can simulate successful operations, validation errors, conflicts, timeouts, partial failures, and unsupported endpoints.

Unit tests

Test:

Rule normalization and serialization.
Alias validation.
IPv4 and IPv6 address parsing.
CIDR and port validation.
Rule ordering.
Diff generation.
Working-copy undo and redo.
Conflict detection.
API error mapping.
Integration tests

Test against a disposable OPNsense test instance:

Load existing rules and aliases.
Create an alias and reference it in a rule.
Update a rule.
Clone and reorder rules.
Delete an alias that is referenced by a rule.
Apply configuration changes.
Verify the resulting state.
Handle invalid payloads.
Handle failed activation.
Detect changes made outside RuleDeck.
End-to-end acceptance tests

The most important test is:

Open the firewall rule grid.
Add a rule.
Create a destination alias directly inside the destination cell.
Add two valid network entries to the alias.
Finish editing the rule.
Confirm both objects appear in the pending change list.
Review the diff.
Apply the changes.
Reload the application.
Verify the rule and alias are still present and correctly linked.

The user must never need to navigate to the dedicated alias page during this workflow.

11. MVP scope

Build the smallest useful product that delivers the signature experience.

Phase 1 — Foundation
Project scaffolding.
Local development environment.
Authentication.
OPNsense connection configuration.
API client.
Version detection.
Read-only retrieval of rules, aliases, interfaces, and supported selection options.
Mock API for development.
Basic error handling.
Phase 2 — Spreadsheet rule editor
Read-only rule grid.
Filtering and search.
Inline cell editing against a local working copy.
Keyboard navigation.
Undo and redo.
Rule cloning.
Diff generation.
Phase 3 — Alias-first workflow
Alias autocomplete.
Inline alias creation.
Alias editing and validation.
Reference tracking.
Alias management page.
Immediate availability of newly created aliases within the local working copy.

This phase is the product's main differentiator.

Phase 4 — Safe deployment
Validate pending changes.
Detect concurrent modifications.
Review additions, modifications, deletions, and reordering.
Apply using supported OPNsense API operations.
Verify the result after applying.
Record an audit event.
Provide clear recovery guidance after failures.
Phase 5 — Quality and packaging
End-to-end testing.
Docker Compose deployment.
Backup and restore of RuleDeck application settings.
Documentation.
Version compatibility checks.
Security review.
Usability polish.

Do not implement VPN management, routing, DHCP, IDS/IPS, user administration, or full firewall monitoring in the initial release. Keep the product focused on policy editing.

12. Definition of done

The MVP is complete when all of the following are true:

A user can connect to a supported OPNsense instance securely.
Existing supported rules and aliases display correctly.
Rules can be edited in a spreadsheet-style grid.
An alias can be created directly from a rule's source or destination cell.
The new alias can be referenced immediately in another pending edit.
Changes are staged locally before they are sent to OPNsense.
The application shows an understandable diff.
The user explicitly confirms activation.
API errors and conflicts are visible and recoverable.
Successful changes are verified against the resulting firewall configuration.
A refresh does not silently erase unsaved work.
Secrets are never exposed to the frontend.
Automated tests cover the core alias-and-rule workflow.
The application can be deployed locally without a cloud dependency.
13. Non-goals and constraints

RuleDeck must not:

Replace the OPNsense packet-filtering engine.
Modify OPNsense source code or require a custom firewall fork.
Depend on undocumented internal files as its primary write interface.
Promise compatibility with every OPNsense release.
Automatically apply changes as the user types.
Silently discard unsupported fields.
Treat runtime alias-table entries as persistent aliases.
Pretend that a successful API response always means the new rules are active.
Implement a full enterprise feature set before the basic editor is reliable.
14. Claude Code working instructions

Before coding, inspect this project book and create a concrete implementation plan.

Follow these rules throughout development:

Inspect current official OPNsense documentation and the actual API behavior before implementing write operations.
Maintain a compatibility document listing verified endpoints, payloads, supported operations, and known limitations.
Start with a mock API and read-only integration.
Implement the spreadsheet grid and inline alias creation before adding peripheral features.
Write tests alongside every critical feature.
Keep domain models separate from OPNsense-specific API representations.
Use typed interfaces and validate all external input.
Never invent API endpoints or assume a payload format.
Never claim a firewall change succeeded without verifying the outcome.
Ask for confirmation before making a decision that could cause significant data loss or change security semantics.
Keep the application runnable after every development phase.
Update the README and project documentation as features are completed.

At the beginning of each phase, explain the planned work and its acceptance criteria. At the end, report what works, what is tested, and what remains incomplete.

Do not attempt to implement every phase in a single enormous code generation step. Build incrementally, run the tests, and fix failures before proceeding.

15. First task for Claude Code

Begin with a discovery and implementation-planning phase.

Deliver these artifacts before implementing write operations:

A concise architecture proposal.
A verified OPNsense API compatibility matrix for the selected target release.
A mapping of firewall rule and alias fields between OPNsense and the internal domain model.
A threat model for credentials, browser sessions, and privileged API operations.
A mock API specification.
A set of executable acceptance tests for inline alias creation and rule editing.
A list of unresolved API questions and compatibility risks.

Then implement Phase 1 and the smallest working version of Phase 2.

The priority is not the number of features. It is making firewall rule creation dramatically better than the native workflow, especially when an alias needs to be created in the middle of editing a rule.

Final product test

A network administrator should be able to say:

"I can build a firewall policy in one table, create the objects I need without leaving that table, understand every change before deployment, and trust the application not to silently alter my firewall."

If RuleDeck achieves that, it has delivered its core value.