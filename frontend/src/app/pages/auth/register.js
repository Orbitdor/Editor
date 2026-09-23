
"use client";

export default function Register() {
  const handleRegister = async (e) => {
    e.preventDefault();

    const name = e.target.name.value;
    const email = e.target.email.value;
    const password = e.target.password.value;

    const res = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL}/api/auth/register`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          email,
          password,
        }),
      }
    );

    const data = await res.json();

    console.log(data);
  };

  return (
    <form onSubmit={handleRegister}>
      <input
        name="name"
        type="text"
        placeholder="Name"
      />

      <input
        name="email"
        type="email"
        placeholder="Email"
      />

      <input
        name="password"
        type="password"
        placeholder="Password"
      />

      <button type="submit">
        Register
      </button>
    </form>
  );
}