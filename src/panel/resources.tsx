// L'onglet Resources : deux cartes, les skills et les fichiers du workspace actif. Lecture seule ici ; le champ de
// filtre est celui de l'accueil (`FilterRow`), partagé par les deux cartes.
import { Button, Callout, IconButton, read, Row, Spinner, Stack, Text, type OrcaElement } from 'orca'
import { EmptyView } from '../blocks/empty-view'
import { GroupCard } from '../blocks/group-card'
import { ItemRow } from '../blocks/item-row'
import type { FileRow, SkillRow } from '../protocol'
import { formatDecimalSize } from '../shared/size'
import { clipBytes } from '../shared/text'
import { RENDER_ROW_CAP } from './config-state'
import { fileRows, filterResources, loadFiles, loadSkills, resourceErrors, skillRows } from './resource-state'
import { ERROR_TEXT_LIMIT_BYTES, filterOf, run, sessionRows } from './state'

/** Plafonds d'un titre et d'un sous-titre de ligne : un libellé de plus de 1 Kio fait refuser le rendu. */
const ROW_TITLE_LIMIT_BYTES = 200
const ROW_SUBTITLE_LIMIT_BYTES = 300

type RowText = { id: string; title: string; subtitle: string }

/** Le titre d'une session pour un fichier qui lui est lié, ou son identifiant quand la session est inconnue. */
function sessionLabel(sessionId: string | null): string {
  if (sessionId === null) return ''
  const known = read(sessionRows)?.find((row) => row.id === sessionId)
  return known?.title ?? sessionId
}

function skillText(row: SkillRow): RowText {
  return { id: row.id, title: row.name, subtitle: row.id }
}

function fileText(row: FileRow): RowText {
  return {
    id: row.id,
    title: row.name,
    subtitle: [row.id, formatDecimalSize(row.sizeBytes), sessionLabel(row.sessionId)].filter(Boolean).join(' · ')
  }
}

/**
 * Une carte : son titre, son `+` (sans action avant la Tâche 4), puis dans l'ordre l'erreur de lecture, le chargement,
 * le vide ou les lignes. Chaque ligne a une clé fixe : une ligne qui apparaît ou disparaît ne décale pas les autres.
 */
function ResourceCard({
  title,
  noun,
  addLabel,
  rows,
  total,
  failure,
  onRetry
}: {
  title: string
  noun: string
  addLabel: string
  /** Les lignes après filtre ; `null` tant que la liste n'est pas lue. */
  rows: RowText[] | null
  /** Le nombre de lignes avant filtre : il distingue une liste vide d'un filtre sans résultat. */
  total: number
  failure: string | null
  onRetry: () => void
}): OrcaElement {
  const shown = rows ?? []
  const items = shown.slice(0, RENDER_ROW_CAP).map((row) => ({
    key: `item-${row.id}`,
    row: (
      <ItemRow
        title={clipBytes(row.title, ROW_TITLE_LIMIT_BYTES).text}
        subtitle={clipBytes(row.subtitle, ROW_SUBTITLE_LIMIT_BYTES).text}
      />
    )
  }))
  return (
    <GroupCard
      title={title}
      trailing={<IconButton icon="add" label={addLabel} variant="ghost" size="sm" onPress={() => {}} />}
      rows={[
        {
          key: 'error',
          row: failure ? (
            <Callout tone="danger" title="Could not load the list">
              <Stack gap="sm">
                <Text size="sm">{clipBytes(failure, ERROR_TEXT_LIMIT_BYTES).text}</Text>
                <Row>
                  <Button variant="outline" size="sm" onPress={onRetry}>
                    Retry
                  </Button>
                </Row>
              </Stack>
            </Callout>
          ) : null
        },
        {
          key: 'status',
          row:
            rows === null ? (
              failure ? null : (
                <Spinner label={`Loading ${noun}`} />
              )
            ) : total === 0 ? (
              <EmptyView kind="list" text={`No ${noun} yet.`} />
            ) : shown.length === 0 ? (
              <EmptyView kind="list" text="No match" />
            ) : null
        },
        ...items,
        {
          key: 'cap',
          row:
            shown.length > RENDER_ROW_CAP ? (
              <Text muted size="xs">
                {`Showing the first ${RENDER_ROW_CAP} of ${shown.length}. Refine the filter to see the rest.`}
              </Text>
            ) : null
        }
      ]}
    />
  )
}

/** Les deux cartes ; le filtre de l'onglet est posé au-dessus par l'accueil. */
export function ResourcesTab(): OrcaElement {
  const query = filterOf('resources')
  const skills = read(skillRows)
  const files = read(fileRows)
  const errors = read(resourceErrors)
  return (
    <Stack gap="sm">
      <ResourceCard
        title="Skills"
        noun="skills"
        addLabel="Upload skill"
        rows={skills === null ? null : filterResources(skills, query).map(skillText)}
        total={skills?.length ?? 0}
        failure={errors.skills}
        onRetry={() => run(loadSkills)}
      />
      <ResourceCard
        title="Files"
        noun="files"
        addLabel="Upload file"
        rows={files === null ? null : filterResources(files, query).map(fileText)}
        total={files?.length ?? 0}
        failure={errors.files}
        onRetry={() => run(loadFiles)}
      />
    </Stack>
  )
}
