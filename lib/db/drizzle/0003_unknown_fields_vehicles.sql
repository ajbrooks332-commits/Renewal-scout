-- Task #11: Add answer-state tracking (unknownFields) and multi-vehicle support
--
-- unknownFields: JSONB array of field names where the user explicitly said
--   "I don't know / prefer not to say". Distinguishes from simply unanswered.
--   Stored alongside the normal profile/requirements columns.
--
-- vehicles: JSONB array of vehicle objects supporting numCars > 1.
--   Existing single-car columns are retained for backward compatibility.
--   Migration below copies any existing single-car data into vehicles[0].

-- household_profile: unknown_fields
ALTER TABLE household_profile
  ADD COLUMN IF NOT EXISTS unknown_fields jsonb NOT NULL DEFAULT '[]'::jsonb;

-- household_profile: vehicles array (multi-vehicle support)
ALTER TABLE household_profile
  ADD COLUMN IF NOT EXISTS vehicles jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Migrate existing single-car data into vehicles[0] (idempotent — only runs
-- when car_make is set and vehicles is still the empty default).
DO $$
BEGIN
  UPDATE household_profile
  SET vehicles = jsonb_build_array(
    jsonb_strip_nulls(
      jsonb_build_object(
        'make',               car_make,
        'model',              car_model,
        'year',               car_year,
        'valuePence',         car_value_pence,
        'annualMileage',      annual_mileage,
        'drivingExperience',  driving_experience,
        'claimsLast5Years',   claims_last_5_years
      )
    )
  )
  WHERE id = 1
    AND car_make IS NOT NULL
    AND vehicles = '[]'::jsonb;
END $$;

-- service_requirements: unknown_fields (array of field keys explicitly unknown)
ALTER TABLE service_requirements
  ADD COLUMN IF NOT EXISTS unknown_fields jsonb NOT NULL DEFAULT '[]'::jsonb;
