import express from "express"
const router = express.Router()

import {Login} from "../controllers/auth/login.controller.js"
import {Register} from "../controllers/auth/register.controller.js"

router.post("/register",Register)
router.post("/login",Login)

export default router