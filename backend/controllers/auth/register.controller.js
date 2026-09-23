import User from "../../models/User.model.js";
export const Register = async (req, res) => {
    try {
        const { name, email, password } = req.body;

        const existingUser = await User.findOne({ email });

        if (existingUser) {
            return res.status(409).json({
                message: "Email already exists"
            });
        }

        const user = new User({
            name,
            email,
            password
        });

        await user.save();

        return res.status(201).json({
            message: "User registered successfully",
            user
        });

    } catch (error) {
        return res.status(500).json({
            message: error.message
        });
    }
};

export default Register;