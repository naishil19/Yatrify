import { randomUUID } from "crypto";

function toDateValue(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return [String(value)];
}

function toJsonArray(value) {
  return JSON.stringify(normalizeArray(value));
}

function mapPlanRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    startCity: row.start_city || "",
    destination: row.destination || "",
    startDate: toDateValue(row.start_date),
    endDate: toDateValue(row.end_date),
    themes: row.themes || [],
    pace: row.pace || "",
    weather: row.weather || "",
    accommodation: row.accommodation || [],
    food: row.food || [],
    transport: row.transport || [],
    currency: row.currency || "INR",
    budget: row.budget || "",
    passengers: row.passengers || "",
    preferences: row.preferences || "",
    sections: row.sections || {},
    heroImageUrl: row.hero_image_url || "",
    isPublished: !!row.is_published,
    publishedAt: row.published_at || null,
    visitStartDate: toDateValue(row.visit_start_date),
    visitEndDate: toDateValue(row.visit_end_date),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCommunityRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    destination: row.destination || "",
    startDate: toDateValue(row.start_date),
    endDate: toDateValue(row.end_date),
    visitStartDate: toDateValue(row.visit_start_date),
    visitEndDate: toDateValue(row.visit_end_date),
    themes: row.themes || [],
    heroImageUrl: row.hero_image_url || "",
    tripTitle: row.trip_title || "",
    summary: row.summary || "",
    source: row.source || "user",
    publishedAt: row.published_at || null,
  };
}

export function createPgStore(pool) {
  async function ensureUser(clerkUserId, profile = {}) {
    const email = profile.email || null;
    const firstName = profile.firstName || null;
    const lastName = profile.lastName || null;
    const imageUrl = profile.imageUrl || null;
    const result = await pool.query(
      `INSERT INTO users (clerk_user_id, email, first_name, last_name, image_url)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (clerk_user_id)
       DO UPDATE SET email = COALESCE(EXCLUDED.email, users.email),
                     first_name = COALESCE(EXCLUDED.first_name, users.first_name),
                     last_name = COALESCE(EXCLUDED.last_name, users.last_name),
                     image_url = COALESCE(EXCLUDED.image_url, users.image_url),
                     updated_at = NOW()
       RETURNING *`,
      [clerkUserId, email, firstName, lastName, imageUrl]
    );
    return result.rows[0];
  }

  async function getUserByClerkId(clerkUserId) {
    const result = await pool.query(
      "SELECT * FROM users WHERE clerk_user_id = $1 LIMIT 1",
      [clerkUserId]
    );
    return result.rows[0] || null;
  }

  async function updateUserPlanTier(userId, planTier) {
    const result = await pool.query(
      `UPDATE users
         SET plan_tier = $2,
             updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [userId, planTier]
    );
    return result.rows[0] || null;
  }

  async function consumeCredits(userId, amount, reason = "adjust", planId = null) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE users
           SET credits = credits - $2,
               updated_at = NOW()
         WHERE id = $1 AND credits >= $2
         RETURNING credits`,
        [userId, amount]
      );
      if (!result.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        `INSERT INTO credit_transactions (id, user_id, plan_id, delta, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), userId, planId, -Math.abs(Number(amount)), reason]
      );
      await client.query("COMMIT");
      return result.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function listPlansForUser(userId) {
    const result = await pool.query(
      `SELECT p.*,
              CASE
                WHEN p.owner_user_id = $1 THEN 'owner'
                ELSE 'collaborator'
              END AS access_role
       FROM plans p
       LEFT JOIN plan_collaborators pc
         ON pc.plan_id = p.id
        AND pc.user_id = $1
        AND pc.status = 'accepted'
       WHERE p.owner_user_id = $1 OR pc.user_id = $1
       ORDER BY p.updated_at DESC`,
      [userId]
    );
    return result.rows.map(mapPlanRow);
  }

  async function getPlanAccess(userId, planId) {
    const result = await pool.query(
      `SELECT p.*,
              CASE
                WHEN p.owner_user_id = $1 THEN 'owner'
                WHEN pc.user_id = $1 AND pc.status = 'accepted' THEN 'collaborator'
                ELSE NULL
              END AS access_role
       FROM plans p
       LEFT JOIN plan_collaborators pc
         ON pc.plan_id = p.id
        AND pc.user_id = $1
        AND pc.status = 'accepted'
       WHERE p.id = $2
       LIMIT 1`,
      [userId, planId]
    );
    if (!result.rows.length) return null;
    const row = result.rows[0];
    return {
      plan: mapPlanRow(row),
      role: row.access_role,
    };
  }

  async function getPlanById(planId) {
    const result = await pool.query("SELECT * FROM plans WHERE id = $1 LIMIT 1", [planId]);
    return mapPlanRow(result.rows[0]);
  }

  async function createPlan(userId, input, sections, meta = {}) {
    const id = randomUUID();
    const values = [
      id,
      userId,
      input.startCity || "",
      input.destination || "",
      toDateValue(input.startDate),
      toDateValue(input.endDate),
      toJsonArray(input.themes),
      input.pace || "",
      input.weather || "",
      toJsonArray(input.accommodation),
      toJsonArray(input.food),
      toJsonArray(input.transport),
      input.currency || "INR",
      input.budget || "",
      input.passengers || "",
      input.preferences || "",
      sections || {},
      meta.heroImageUrl || null,
    ];
    const result = await pool.query(
      `INSERT INTO plans (
         id, owner_user_id, start_city, destination, start_date, end_date,
         themes, pace, weather, accommodation, food, transport,
         currency, budget, passengers, preferences, sections, hero_image_url
       )
       VALUES (
         $1,$2,$3,$4,$5,$6,
         $7,$8,$9,$10,$11,$12,
         $13,$14,$15,$16,$17,$18
       )
       RETURNING *`,
      values
    );
    return mapPlanRow(result.rows[0]);
  }

  async function updatePlan(userId, planId, updates) {
    const result = await pool.query(
      `UPDATE plans
       SET start_city = COALESCE($2, start_city),
           destination = COALESCE($3, destination),
           start_date = COALESCE($4, start_date),
           end_date = COALESCE($5, end_date),
           themes = COALESCE($6, themes),
           pace = COALESCE($7, pace),
           weather = COALESCE($8, weather),
           accommodation = COALESCE($9, accommodation),
           food = COALESCE($10, food),
           transport = COALESCE($11, transport),
           currency = COALESCE($12, currency),
           budget = COALESCE($13, budget),
           passengers = COALESCE($14, passengers),
           preferences = COALESCE($15, preferences),
           hero_image_url = COALESCE($16, hero_image_url),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        planId,
        updates.startCity ?? null,
        updates.destination ?? null,
        updates.startDate ? toDateValue(updates.startDate) : null,
        updates.endDate ? toDateValue(updates.endDate) : null,
        updates.themes ? toJsonArray(updates.themes) : null,
        updates.pace ?? null,
        updates.weather ?? null,
        updates.accommodation ? toJsonArray(updates.accommodation) : null,
        updates.food ? toJsonArray(updates.food) : null,
        updates.transport ? toJsonArray(updates.transport) : null,
        updates.currency ?? null,
        updates.budget ?? null,
        updates.passengers ?? null,
        updates.preferences ?? null,
        updates.heroImageUrl ?? null,
      ]
    );
    return mapPlanRow(result.rows[0]);
  }

  async function updatePlanSections(userId, planId, sections) {
    const result = await pool.query(
      `UPDATE plans
       SET sections = $2,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [planId, sections || {}]
    );
    return mapPlanRow(result.rows[0]);
  }

  async function updatePlanItinerary(planId, itinerary) {
    const plan = await getPlanById(planId);
    if (!plan) return null;
    const nextSections = Object.assign({}, plan.sections || {});
    nextSections.itinerary = Array.isArray(itinerary) ? itinerary : [];
    const result = await pool.query(
      `UPDATE plans
         SET sections = $2,
             updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [planId, nextSections]
    );
    return mapPlanRow(result.rows[0]);
  }

  async function deletePlan(userId, planId) {
    const result = await pool.query(
      `DELETE FROM plans WHERE id = $1 AND owner_user_id = $2`,
      [planId, userId]
    );
    return result.rowCount > 0;
  }

  async function setPlanPublished(userId, planId, publish, visitStartDate, visitEndDate) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE plans
         SET is_published = $3,
             published_at = CASE WHEN $3 THEN NOW() ELSE NULL END,
             visit_start_date = $4,
             visit_end_date = $5,
             updated_at = NOW()
         WHERE id = $1 AND owner_user_id = $2
         RETURNING *`,
        [
          planId,
          userId,
          publish,
          visitStartDate ? toDateValue(visitStartDate) : null,
          visitEndDate ? toDateValue(visitEndDate) : null,
        ]
      );
      if (!result.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      if (publish) {
        await client.query(
          `INSERT INTO community_plans (id, plan_id, source, is_active, sort_order, created_at, published_at)
           VALUES ($1, $2, 'user', TRUE, 0, NOW(), NOW())
           ON CONFLICT (plan_id)
           DO UPDATE SET is_active = TRUE, source = 'user', published_at = NOW()`,
          [randomUUID(), planId]
        );
      } else {
        await client.query(
          `UPDATE community_plans
           SET is_active = FALSE, published_at = NULL
           WHERE plan_id = $1`,
          [planId]
        );
      }
      await client.query("COMMIT");
      return mapPlanRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function listCommunityPlans() {
    const result = await pool.query(
      `SELECT p.id,
              p.destination,
              p.start_date,
              p.end_date,
              p.visit_start_date,
              p.visit_end_date,
              p.themes,
              p.hero_image_url,
              cp.source,
              cp.published_at,
              p.sections->'tripHighlights'->>'tripTitle' AS trip_title,
              p.sections->'tripHighlights'->>'summary' AS summary
       FROM community_plans cp
       JOIN plans p ON p.id = cp.plan_id
       WHERE cp.is_active = true
       ORDER BY cp.sort_order ASC, cp.published_at DESC, p.updated_at DESC`
    );
    return result.rows.map(mapCommunityRow);
  }

  async function getCommunityPlan(planId) {
    const result = await pool.query(
      `SELECT p.*
       FROM community_plans cp
       JOIN plans p ON p.id = cp.plan_id
       WHERE cp.plan_id = $1 AND cp.is_active = true
       LIMIT 1`,
      [planId]
    );
    return mapPlanRow(result.rows[0]);
  }

  async function listCollaborators(planId) {
    const result = await pool.query(
      `SELECT pc.*, u.email, u.first_name, u.last_name
       FROM plan_collaborators pc
       LEFT JOIN users u ON u.id = pc.user_id
       WHERE pc.plan_id = $1
       ORDER BY pc.created_at DESC`,
      [planId]
    );
    const mapped = result.rows.map((row) => ({
      id: row.id,
      planId: row.plan_id,
      invitedEmail: String(row.invited_email || "").trim().toLowerCase(),
      userId: row.user_id,
      role: row.role,
      status: String(row.status || "").trim().toLowerCase(),
      name: [row.first_name, row.last_name].filter(Boolean).join(" "),
      email: String(row.email || row.invited_email || "").trim().toLowerCase(),
      createdAt: row.created_at,
    }));

    // Deduplicate same collaborator email/user so accepted state wins.
    const rankStatus = (status) => (status === "accepted" ? 2 : status === "invited" ? 1 : 0);
    const deduped = new Map();
    mapped.forEach((item) => {
      const key =
        String(item.invitedEmail || item.email || item.userId || item.id || "")
          .trim()
          .toLowerCase() || String(item.id || "").trim().toLowerCase();
      if (!key) return;
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, item);
        return;
      }
      if (rankStatus(item.status) > rankStatus(existing.status)) {
        deduped.set(key, item);
      }
    });

    return Array.from(deduped.values());
  }

  async function inviteCollaborator(planId, email) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (!cleanEmail) {
      throw new Error("Email is required");
    }
    const userResult = await pool.query(
      "SELECT id FROM users WHERE lower(email) = $1 LIMIT 1",
      [cleanEmail]
    );
    const userId = userResult.rows[0] ? userResult.rows[0].id : null;

    // Keep invite flow compatible with older schemas that may not have a
    // unique(plan_id, invited_email) constraint or updated_at column.
    const existing = await pool.query(
      `SELECT id
       FROM plan_collaborators
       WHERE plan_id = $1
         AND lower(invited_email) = lower($2)
       LIMIT 1`,
      [planId, cleanEmail]
    );

    if (existing.rows[0]) {
      const updateResult = await pool.query(
        `UPDATE plan_collaborators
         SET user_id = COALESCE($2, user_id),
             role = 'collaborator',
             status = 'invited'
         WHERE id = $1
         RETURNING *`,
        [existing.rows[0].id, userId]
      );
      return updateResult.rows[0] || null;
    }

    const insertResult = await pool.query(
      `INSERT INTO plan_collaborators (id, plan_id, invited_email, user_id, role, status)
       VALUES ($1, $2, $3, $4, 'collaborator', 'invited')
       RETURNING *`,
      [randomUUID(), planId, cleanEmail, userId]
    );
    return insertResult.rows[0] || null;
  }

  async function acceptInvite(planId, userId, email) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    const result = await pool.query(
      `UPDATE plan_collaborators
       SET user_id = $2,
           status = 'accepted'
       WHERE plan_id = $1 AND (user_id = $2 OR invited_email = $3)
       RETURNING *`,
      [planId, userId, cleanEmail]
    );
    return result.rows[0] || null;
  }

  async function acceptInviteById(planId, inviteId, userId) {
    const target = await pool.query(
      `SELECT invited_email
       FROM plan_collaborators
       WHERE plan_id = $1
         AND id = $2
       LIMIT 1`,
      [planId, inviteId]
    );
    if (!target.rows[0]) return null;

    const invitedEmail = String(target.rows[0].invited_email || "").trim().toLowerCase();
    const result = await pool.query(
      `UPDATE plan_collaborators
       SET user_id = $3,
           status = 'accepted'
       WHERE plan_id = $1
         AND (
           id = $2
           OR user_id = $3
           OR ($4 <> '' AND lower(invited_email) = lower($4))
         )
       RETURNING *`,
      [planId, inviteId, userId, invitedEmail]
    );
    const exact = result.rows.find((row) => row.id === inviteId);
    return exact || result.rows[0] || null;
  }

  async function revokeCollaborator(planId, collaboratorId, collaboratorEmail) {
    var result = null;
    if (collaboratorId) {
      result = await pool.query(
        `DELETE FROM plan_collaborators
         WHERE plan_id = $1
           AND id = $2
         RETURNING *`,
        [planId, collaboratorId]
      );
      if (result.rows[0]) return result.rows[0];
    }

    var cleanEmail = String(collaboratorEmail || "").trim().toLowerCase();
    if (cleanEmail) {
      result = await pool.query(
        `DELETE FROM plan_collaborators
         WHERE plan_id = $1
           AND lower(invited_email) = lower($2)
         RETURNING *`,
        [planId, cleanEmail]
      );
      if (result.rows[0]) return result.rows[0];
    }

    return null;
  }

  async function listExpenses(planId) {
    const result = await pool.query(
      `SELECT * FROM expenses WHERE plan_id = $1 ORDER BY date DESC NULLS LAST, created_at DESC`,
      [planId]
    );
    return result.rows;
  }

  async function createExpense(planId, userId, expense) {
    const result = await pool.query(
      `INSERT INTO expenses (id, plan_id, user_id, description, who, category, amount, date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        randomUUID(),
        planId,
        userId,
        expense.description || "",
        expense.who || "",
        expense.category || "",
        Number(expense.amount || 0),
        expense.date ? toDateValue(expense.date) : null,
      ]
    );
    return result.rows[0];
  }

  async function updateExpense(planId, userId, expenseId, expense) {
    const result = await pool.query(
      `UPDATE expenses
       SET description = COALESCE($4, description),
           who = COALESCE($5, who),
           category = COALESCE($6, category),
           amount = COALESCE($7, amount),
           date = COALESCE($8, date),
           updated_at = NOW()
       WHERE id = $1 AND plan_id = $2 AND user_id = $3
       RETURNING *`,
      [
        expenseId,
        planId,
        userId,
        expense.description ?? null,
        expense.who ?? null,
        expense.category ?? null,
        typeof expense.amount === "number" ? expense.amount : null,
        expense.date ? toDateValue(expense.date) : null,
      ]
    );
    return result.rows[0];
  }

  async function deleteExpense(planId, userId, expenseId) {
    const result = await pool.query(
      `DELETE FROM expenses WHERE id = $1 AND plan_id = $2 AND user_id = $3`,
      [expenseId, planId, userId]
    );
    return result.rowCount > 0;
  }

  return {
    ensureUser,
    getUserByClerkId,
    updateUserPlanTier,
    consumeCredits,
    listPlansForUser,
    getPlanAccess,
    getPlanById,
    createPlan,
    updatePlan,
    updatePlanSections,
    updatePlanItinerary,
    deletePlan,
    setPlanPublished,
    listCommunityPlans,
    getCommunityPlan,
    listCollaborators,
    inviteCollaborator,
    acceptInvite,
    acceptInviteById,
    revokeCollaborator,
    listExpenses,
    createExpense,
    updateExpense,
    deleteExpense,
  };
}


