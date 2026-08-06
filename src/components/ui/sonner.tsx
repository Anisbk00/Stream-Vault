"use client"

import { Toaster as Sonner, ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      position="top-right"
      className="toaster group"
      style={
        {
          "--normal-bg": "#1a1a1a",
          "--normal-text": "#F5F5F5",
          "--normal-border": "rgba(255,255,255,0.08)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
