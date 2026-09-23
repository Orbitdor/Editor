"use client";

export default function Login() {
  const handleLogin = async (e) => {
    e.preventDefault();

    const email = e.target.email.value;
    const password = e.target.password.value;

    const res = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL}/api/auth/login`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
        }),
      }
    );

    const data = await res.json();

    console.log(data);
  };

  return (
    <form onSubmit={handleLogin}>
      <input name="email" type="email" placeholder="Email" />

      <input name="password" type="password" placeholder="Password" />

      <button type="submit">Login</button>
    </form>
  );
}