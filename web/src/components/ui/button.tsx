import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx } from 'clsx';
const variants = cva('button', { variants: { variant: { default: 'button-metal', secondary: 'button-glass', ghost: 'button-ghost' } }, defaultVariants: { variant: 'default' } });
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof variants> { asChild?: boolean }
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({className, variant, asChild = false, ...props}, ref) => { const Comp = asChild ? Slot : 'button'; return <Comp ref={ref} className={clsx(variants({variant}), className)} {...props}/>; });
Button.displayName = 'Button';
