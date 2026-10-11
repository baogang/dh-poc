# V2 test release

600 emotion-only references derive from v1.2 by removing business intents and their evidence; sentiment/emotion/SA labels are unchanged. 80 planning and 60 engineering contracts are byte-equivalent in JSON meaning to v1.2. 32 new integration cases separately exercise negative-to-human routing, normal business lookup, mixed/undetermined, unavailable handoff, mid-session handoff and explicit self-service resumption.

References are synthetic/provisional and not independently reviewed Saudi production labels. Previously inspected holdout splits are regression evidence, not new blind evidence. Planning-only invokes no emotion model. Integration references enter the scorer only after execution. Handoff is a local simulation; no real staff connection.
