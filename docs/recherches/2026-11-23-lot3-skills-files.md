# Recherche pré-plan : skills et fichiers (lot 3)

Date : 23/11/2026. Spec : `docs/superpowers/specs/2026-11-23-managed-agents-resources-design.md` (§ 3, six inconnues). Échantillons capturés sur le workspace de test `Orca-claude` (`wrkspc_013Mp1kNaYDSgw93rzjxpQkF`), au travers du worker du plugin (sonde jetable retirée ensuite), avec des objets `plugin-test-…` créés puis supprimés.

## Sources primaires

Lues le 23/11/2026. Les pages ne portent pas de date de révision ; leurs exemples sont en `anthropic-version: 2026-10-21`. Code HTTP vérifié par `curl -L` le même jour.

| URL | HTTP | Sert à |
|---|---|---|
| https://platform.claude.com/docs/en/build-with-claude/skills-guide | 200 | Limite 30 MB, suppression en cascade, `name` identique entre versions, sortie de bêta |
| https://platform.claude.com/docs/en/api/skills/versions/create | 200 | Objet `skill_version`, slug immuable |
| https://platform.claude.com/docs/en/api/skills/delete | 200 | Réponse `skill_deleted`, aucun code « en usage » |
| https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview | 200 | Frontmatter : `name` ≤ 64 car., minuscules, chiffres, tirets ; `description` obligatoire ≤ 1024 |
| https://platform.claude.com/docs/en/build-with-claude/files | 200 | 500 MB par fichier, 1 TB par organisation, sortie de bêta, pagination |
| https://platform.claude.com/docs/en/managed-agents/files | 200 | `scope_id` exige l'en-tête `managed-agents-2026-04-01` |

Citations qui tranchent :
- « The Skills API is out of beta and needs no beta header. » « Starting with … TypeScript SDK 0.122.0 …, `client.beta.skills` … no longer sends `skills-2025-10-02` ». Même phrase pour la Files API et `files-api-2025-04-14`.
- « Maximum Skill upload size: 30 MB (all files combined, uncompressed) ».
- « Deleting a Skill also deletes all of its versions. »
- « the `name` in the new version's `SKILL.md` must match the Skill's existing name. »
- « Maximum file size: 500 MB for each file ».
- « Filtering by `scope_id` … requires the `managed-agents-2026-04-01` beta header ».

## Versions épinglées

- `@anthropic-ai/sdk` **1.8.0** (`package.json` : `^1.8.0`, installé 1.8.0). Il expose les espaces **stables** `client.skills` (avec `client.skills.versions`) et `client.files`, en plus de `client.beta.skills` et `client.beta.files`. Le plan utilise les espaces stables : aucun en-tête beta n'est envoyé, et c'est le chemin que les sondes ont joué.
- `toFile` est exporté par `@anthropic-ai/sdk` (`core/uploads`).

## Échantillons réels

Fichiers bruts dans `docs/superpowers/runs/lot3/` (`r*.json`, non versionnés). Extraits verbatim.

**Liste des skills** (`client.skills.list({ source: 'custom' })`, `r1-list.json`) : trois skills de Romain, dont deux nommées `vulgarise` aux ids différents. Le doublon que l'id affiché permet de distinguer existe déjà. Sans `source`, la première page mélange les skills `custom` et celles d'Anthropic (`{ "id": "xlsx", "display_name": "xlsx", "source": { "type": "anthropic" } }`).

**Création d'une skill** (`client.skills.create({ files })`, fichiers nommés `plugin-test-skill/SKILL.md` et `plugin-test-skill/refs/note.md`, `r2`) :
```json
{ "type": "skill", "id": "skill_01ETzRJeACcudynZRCuwTX9a", "display_name": "plugin-test-skill",
  "source": { "type": "custom" }, "latest_version_id": "skver_01SQms5g47X3vWGKdAR1cweJ",
  "created_at": "2026-11-23T20:24:12.647016Z", "updated_at": "2026-11-23T20:24:12.647016Z" }
```
`source` est un objet `{ type }`, pas une chaîne.

**Nouvelle version** (`client.skills.versions.create(skillId, { files })`, `r3`) : même `id` ; `latest_version_id` passe à `skver_018gCczhQXGjSF4zPSAMctDD` ; `updated_at` prend l'heure de la version (`20:24:19`), donc le tri par `updated_at` fait remonter une skill renvoyée.
```json
{ "type": "skill_version", "id": "skver_018gCczhQXGjSF4zPSAMctDD", "skill_id": "skill_01ETzRJeACcudynZRCuwTX9a",
  "name": "plugin-test-skill", "description": "Throwaway skill for the plugin lot 3 probe. v2",
  "created_at": "2026-11-23T20:24:19.487544Z" }
```

**Version avec un autre `name`** (`r4`) : HTTP 400.
```json
{ "type": "error", "error": { "type": "invalid_request_error",
  "message": "Skill name 'plugin-test-other' in SKILL.md must be consistent across all versions for a given `skill_id`. Expected 'plugin-test-skill'." },
  "request_id": "req_011ChLV7moqTTtZwhK4XWsAd" }
```

**Version depuis un dossier d'un autre nom** (`plugin-test-otherdir/SKILL.md`, même `name`, `r5`) : acceptée (`skver_01WQA6cYEPWiKdUEajn2jAM7`). Le nom du dossier choisi n'a pas d'importance.

**Suppression d'une skill à trois versions, référencée par un agent** (`r6` à `r9`) :
- L'agent `plugin-test-skill-ref` (`agent_01N1HaSBjFiXHeCsjMd6R5bf`) référence la skill : `{ "skill_id": "skill_01ETz…", "type": "custom", "version": "latest" }`.
- `client.skills.delete(skillId)` répond `{ "type": "skill_deleted", "id": "skill_01ETzRJeACcudynZRCuwTX9a" }` en un seul appel.
- Relu ensuite, l'agent garde la référence à la skill supprimée, sans erreur ni marque.
- `client.skills.retrieve(skillId)` répond 404 : `{ "type": "not_found_error", "message": "Skill not found: skill_01ETzRJeACcudynZRCuwTX9a" }`.
- L'agent de test est archivé (`archived_at: 2026-11-23T20:24:50.799716Z`). Il reste à vie, comme convenu.

**Limite de taille d'une skill** (`r18`, `r20`) :
- 31 000 000 octets de contenu : acceptée. La skill de test a été supprimée aussitôt.
- 32 000 000 octets : HTTP 413, corps sans `request_id` :
```json
{ "error": { "type": "request_too_large", "message": "Request exceeds the maximum size. The Skills API accepts requests up to 30MBs." } }
```
La limite porte sur la requête et vaut 30 Mio (31 457 280 octets), en-têtes multipart compris.

**Fichier** (`client.files.upload({ file })`, `r12` à `r14`) :
```json
{ "type": "file", "id": "file_01KC9HLBRzfe2Jjh21gjizHJ", "size_bytes": 19, "created_at": "2026-11-23T20:25:02.693665Z",
  "expires_at": null, "filename": "plugin-test-file.txt", "mime_type": "text/plain", "downloadable": false }
```
- Un fichier téléversé n'a pas de champ `scope`.
- `client.files.delete(id)` répond `{ "id": "file_01KC9HLBRzfe2Jjh21gjizHJ", "type": "file_deleted" }`.
- Relu ensuite, il répond 404 : `{ "type": "not_found_error", "message": "File `file_01KC9HLBRzfe2Jjh21gjizHJ` not found." }`.

**Fichiers de session** (`r15`, `r16`) :
- `client.files.list({ scope_id })` sans en-tête répond 400 `scope_id: unknown field`.
- `client.beta.files.list({ scope_id, betas: ['managed-agents-2026-04-01'] })` passe. Sur les 7 sessions du workspace, archivées comprises, il n'y a aucun fichier de session.

**Noms des classes d'erreur** : dans le bundle du worker, les classes s'appellent `BadRequestError2`, `NotFoundError2` et `ContentTooLargeError2`. Il faut tester `instanceof Anthropic.APIError` et `status`, jamais le nom.

## Incertitudes

1. **Fichiers produits par une session** : aucun n'existe sur le workspace. Trois points restent non prouvés : leur présence dans `files.list()` sans `scope_id`, leur suppression, et leur `expires_at`. La doc n'en dit rien. Le plan ne doit pas les supposer : la branche « titre de session » du § 5.3 et l'AC-10 restent « infra non accessible : convention non confirmée ». Pour les prouver, il faudrait une session qui écrit dans `/mnt/session/outputs/`, donc un agent actif de plus, ce qui sort de l'accord du 23/11.
2. **Supprimer un fichier monté par une session** : non documenté, non joué. Le plan affiche le refus éventuel de l'API, sans rien supposer.
3. **Nombre maximal de fichiers par skill, profondeur et types** : non documentés. Seule la limite de 30 Mio a été prouvée.
4. **Taille réelle maximale d'un fichier** : 500 MB documentés, non joués. Le plafond de 100 MB de la spec reste en dessous.

## Verdict

**Prêt pour le plan**, avec quatre corrections à reporter dans la spec avant de l'écrire :
1. Passer aux espaces stables `client.skills`, `client.skills.versions` et `client.files`, sans en-tête beta.
2. Une seule requête `skills.delete` supprime la skill et toutes ses versions. On retire la branche « supprimer les versions d'abord » et l'avis de progression partielle.
3. L'API laisse supprimer une skill référencée, et l'agent garde un lien mort. La ligne fixe de la confirmation devient ferme.
4. Le plafond d'une skill passe à 30 MB de contenu (30 000 000 octets), vérifié avant l'appel. On garde ainsi une marge sous les 30 Mio de la requête, car l'enveloppe multipart compte.

Aucun point ne demande l'avis de Romain, sauf s'il veut prouver les fichiers de session (incertitude 1) en autorisant un second agent de test.
