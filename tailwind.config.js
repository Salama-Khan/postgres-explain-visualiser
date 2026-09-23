/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        /** Node severity colours — expanded when we add diagnostic rules */
        "node-critical": "#ef4444",
        "node-warning": "#f59e0b",
        "node-ok": "#10b981",
      },
    },
  },
  plugins: [],
}

