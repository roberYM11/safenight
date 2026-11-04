import { z } from 'zod';
import { sha256 } from '../cloud/contracts.ts';
import { featureSchema } from '../forest.ts';

export const inputSchema = z.object({
  entity_id: z.string(), observed_at: z.string(), observation_revision_id: z.string(), payload_json: z.string(),
  location_revision_id: z.string().nullable(), lat: z.number().nullable(), lon: z.number().nullable(),
});
export type FrozenInput = z.infer<typeof inputSchema>;
const measurement = z.object({ lux: z.number().finite().nonnegative().nullable(), noise_db: z.number().finite().min(0).max(200).nullable() });

/** Select only keys touched by this publication, from history at this exact sequence.
 * Location corrections revisit affected historical observations, not just today's latest.
 */
export async function inputPage(db: D1Database, sequence: number, cutoff: string, entity: string, time: string, limit: number): Promise<readonly FrozenInput[]> {
  const query = `WITH touched AS (
    SELECT source,entity_id,observed_at FROM observation_selections WHERE publication_sequence=?
  ), keys AS (
    SELECT entity_id,observed_at FROM touched WHERE source='sdot'
    UNION
    SELECT s.entity_id,s.observed_at FROM observation_selections s
    WHERE s.source='sdot' AND s.publication_sequence<=?
      AND s.entity_id IN(SELECT entity_id FROM touched WHERE source='sensor_locations')
  ), paged AS (
    SELECT entity_id,observed_at FROM keys WHERE observed_at<=? AND (entity_id>? OR (entity_id=? AND observed_at>?))
    ORDER BY entity_id,observed_at LIMIT ?
  ) SELECT v.entity_id,v.observed_at,r.id AS observation_revision_id,r.payload_json,
    l.id AS location_revision_id,l.lat,l.lon
  FROM paged v JOIN observation_revisions r ON r.id=(
    SELECT s.revision_id FROM observation_selections s WHERE s.source='sdot' AND s.entity_id=v.entity_id
    AND s.observed_at=v.observed_at AND s.publication_sequence<=? ORDER BY s.publication_sequence DESC LIMIT 1
  )
  LEFT JOIN observation_revisions l ON l.id=(
    SELECT p.revision_id FROM observation_selections p WHERE p.source='sensor_locations' AND p.entity_id=v.entity_id
    AND p.observed_at<=v.observed_at AND p.publication_sequence<=? ORDER BY p.observed_at DESC,p.publication_sequence DESC LIMIT 1
  ) ORDER BY v.entity_id,v.observed_at`;
  return z.array(inputSchema).parse((await db.prepare(query).bind(sequence, sequence, cutoff, entity, entity, time, limit, sequence, sequence).all()).results);
}

export async function featureFromInput(row: FrozenInput) {
  if (row.location_revision_id === null || row.lat === null || row.lon === null) return null;
  const values = measurement.parse(JSON.parse(row.payload_json));
  const feature_revision = await sha256(new TextEncoder().encode(`${row.observation_revision_id}:${row.location_revision_id}:environment-v1`));
  return featureSchema.parse({ sensor_id: row.entity_id, observed_at: row.observed_at, lat: row.lat, lon: row.lon, ...values, feature_version: 'environment-v1', feature_revision });
}
