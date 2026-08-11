import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, servicesTable, serviceRequirementsTable } from "@workspace/db";
import {
  StrictUpdateServiceRequirementsBody,
  getRequirementFieldNames,
  getRequirementFieldsSchema,
  parseRouteId,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/require-auth";

const router: IRouter = Router();
router.use(requireAuth);

// GET /services/:id/requirements
router.get("/services/:id/requirements", async (req, res): Promise<void> => {
  const id = parseRouteId(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id: must be a positive integer." });
    return;
  }

  const [service] = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.id, id));
  if (!service) {
    res.status(404).json({ error: "Service not found." });
    return;
  }

  const [req_row] = await db
    .select()
    .from(serviceRequirementsTable)
    .where(eq(serviceRequirementsTable.serviceId, id));

  if (!req_row) {
    res.json({
      serviceId: id,
      schemaVersion: "1",
      fields: {},
      unknownFields: [],
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  res.json({
    serviceId:    req_row.serviceId,
    schemaVersion: req_row.schemaVersion,
    fields:        req_row.fields,
    unknownFields: req_row.unknownFields ?? [],
    updatedAt:     req_row.updatedAt.toISOString(),
  });
});

// PUT /services/:id/requirements
router.put("/services/:id/requirements", async (req, res): Promise<void> => {
  const id = parseRouteId(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id: must be a positive integer." });
    return;
  }

  const [service] = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.id, id));
  if (!service) {
    res.status(404).json({ error: "Service not found." });
    return;
  }

  // Validate top-level structure: must have a `fields` object; unknown top-level
  // keys rejected by .strict() in the Zod schema.
  const parsed = StrictUpdateServiceRequirementsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation failed.",
      details: parsed.error.format(),
    });
    return;
  }

  // Validate both field names and values against the service-specific strict
  // schema. This rejects cross-service keys, string booleans, negative costs,
  // invalid select values, decimals in integer fields, NaN and Infinity.
  const fieldsResult = getRequirementFieldsSchema(service.serviceType).safeParse(
    parsed.data.fields,
  );
  if (!fieldsResult.success) {
    res.status(400).json({
      error: `Requirement validation failed for service type "${service.serviceType}".`,
      details: fieldsResult.error.format(),
    });
    return;
  }

  const validatedFields = fieldsResult.data as Record<string, unknown>;
  const allowed = new Set(getRequirementFieldNames(service.serviceType));

  // unknownFields: array of field names the user explicitly marked as unknown.
  // Reject any that are not in the allowlist.
  const badUnknownFields = (parsed.data.unknownFields ?? []).filter(
    (k) => !allowed.has(k),
  );
  if (badUnknownFields.length > 0) {
    res.status(400).json({
      error:
        `Unknown field name(s) in unknownFields for service type "${service.serviceType}": ` +
        `${badUnknownFields.map((k) => JSON.stringify(k)).join(", ")}`,
    });
    return;
  }
  const unknownFields = parsed.data.unknownFields ?? [];

  const inconsistentUnknownFields = unknownFields.filter(
    (key) => validatedFields[key] !== null,
  );
  if (inconsistentUnknownFields.length > 0) {
    res.status(400).json({
      error:
        "Fields marked as unknown must be present in fields with a null value: " +
        inconsistentUnknownFields.map((key) => JSON.stringify(key)).join(", "),
    });
    return;
  }

  const [existing] = await db
    .select()
    .from(serviceRequirementsTable)
    .where(eq(serviceRequirementsTable.serviceId, id));

  let row;
  if (existing) {
    [row] = await db
      .update(serviceRequirementsTable)
      .set({ fields: validatedFields, unknownFields, updatedAt: new Date() })
      .where(eq(serviceRequirementsTable.serviceId, id))
      .returning();
  } else {
    [row] = await db
      .insert(serviceRequirementsTable)
      .values({ serviceId: id, fields: validatedFields, unknownFields })
      .returning();
  }

  res.json({
    serviceId:    row!.serviceId,
    schemaVersion: row!.schemaVersion,
    fields:        row!.fields,
    unknownFields: row!.unknownFields ?? [],
    updatedAt:     row!.updatedAt.toISOString(),
  });
});

export default router;
