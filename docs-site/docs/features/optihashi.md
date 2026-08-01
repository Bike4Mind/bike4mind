---
title: OptiHashi
description: AI-driven optimization engine for scheduling and resource allocation
sidebar_position: 18
---

# OptiHashi

OptiHashi is Bike4Mind's optimization engine. It provides AI-driven schedule optimization and resource allocation using a range of advanced solvers, accessible both through the sidebar dashboard and as smart tools within notebooks.

## Features

### Schedule Optimization

Run optimization solvers on scheduling problems to find optimal or near-optimal solutions. OptiHashi supports a variety of solver backends and can handle complex constraints including:

- Resource availability windows
- Task dependencies and ordering
- Capacity limits
- Multi-objective trade-offs

### Problem Formulation

Describe your scheduling problem in plain English and the AI will convert it into structured input that the optimization engine can solve. No need to manually define variables and constraints.

### Dashboard

Access the OptiHashi dashboard from the sidebar to:

- View and manage optimization runs
- Inspect solver results and schedules
- Compare alternative solutions
- Export optimized schedules

## Smart Tools Integration

OptiHashi exposes optimization capabilities as smart tools within notebooks:

- **Schedule Optimization** -- submit and solve scheduling problems directly from chat
- **Problem Formulation** -- convert natural language descriptions into solver-ready input

## FAQ

**How do I access OptiHashi?**
OptiHashi appears in the sidebar when enabled for your account. You can also use the optimization smart tools directly in any notebook.

**What types of problems can OptiHashi solve?**
OptiHashi specializes in scheduling and resource allocation problems -- shift scheduling, project planning, task assignment, and similar combinatorial optimization challenges.

**How long does an optimization run take?**
Run time depends on problem complexity. Simple problems solve in seconds; larger problems with many constraints may take longer. The dashboard shows progress in real time.

## Related

- [Smart Tools](./smart-tools.md) -- using optimization tools in notebooks
- [Profile Settings](./profile-settings.md) -- enabling OptiHashi
