import User from "../../models/User.model.js"
export const Login = (req,res)=> {
    const {email,password} = req.body
    const user = User.findOne({email,password})
    if(!user){
        return res.status(400).json({
            message:"user not exist"
        })
    }else(
        res.status(200).json({
            message:"login successfully"
        })
    )
}