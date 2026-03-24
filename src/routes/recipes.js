const express = require("express");
const { getRecipes, deleteRecipe } = require("../recipes/store");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// GET /api/recipes — public, returns all recipes
router.get("/", async (_req, res) => {
  try {
    const recipes = await getRecipes();
    res.json(recipes);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch recipes" });
  }
});

// DELETE /api/recipes/:id — requires auth, delete recipe
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const deleted = await deleteRecipe(req.params.id);
    if (deleted) return res.json({ deleted: true });
    return res.status(404).json({ error: "Recipe not found" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete recipe" });
  }
});

module.exports = router;
